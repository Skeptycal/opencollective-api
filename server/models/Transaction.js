/** @module models/Transaction */

import Promise from 'bluebird';
import axios from 'axios';
import activities from '../constants/activities';
import { TransactionTypes } from '../constants/transactions';
import CustomDataTypes from './DataTypes';
import uuidv4 from 'uuid/v4';
import { ledger } from 'config';
import debugLib from 'debug';
import { toNegative } from '../lib/math';
import { exportToCSV } from '../lib/utils';
import { get } from 'lodash';
import moment from 'moment';

const debug = debugLib('transaction');

/*
 * Transaction model
 * - this indicates that money was moved in the system
 */
export default (Sequelize, DataTypes) => {
  const { models } = Sequelize;

  const Transaction = Sequelize.define(
    'Transaction',
    {
      type: DataTypes.STRING, // DEBIT or CREDIT

      uuid: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        unique: true,
      },

      description: DataTypes.STRING,
      amount: DataTypes.INTEGER,

      currency: CustomDataTypes(DataTypes).currency,

      CreatedByUserId: {
        type: DataTypes.INTEGER,
        references: {
          model: 'Users',
          key: 'id',
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        allowNull: false,
      },

      // Source of the money for a DEBIT
      // Recipient of the money for a CREDIT
      FromCollectiveId: {
        type: DataTypes.INTEGER,
        references: {
          model: 'Collectives',
          key: 'id',
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        allowNull: true, // when a host adds funds, we need to create a transaction to add money to the system (to the host collective)
      },

      CollectiveId: {
        type: DataTypes.INTEGER,
        references: {
          model: 'Collectives',
          key: 'id',
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        allowNull: false,
      },

      // Keeps a reference to the host because this is where the bank account is
      // Note that the host can also change over time (that's why just keeping CollectiveId is not enough)
      HostCollectiveId: {
        type: DataTypes.INTEGER,
        references: {
          model: 'Collectives',
          key: 'id',
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        allowNull: true, // the opposite transaction that records the CREDIT to the User that submitted an expense doesn't have a HostCollectiveId, see https://github.com/opencollective/opencollective/issues/1154
      },

      OrderId: {
        type: DataTypes.INTEGER,
        references: {
          model: 'Orders',
          key: 'id',
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        allowNull: true,
      },

      // Refactor: an Expense should be an Order
      ExpenseId: {
        type: DataTypes.INTEGER,
        references: {
          model: 'Expenses',
          key: 'id',
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        allowNull: true,
      },

      // stores the currency that the transaction happened in (currency of the host)
      hostCurrency: {
        type: DataTypes.STRING,
        set(val) {
          if (val && val.toUpperCase) {
            this.setDataValue('hostCurrency', val.toUpperCase());
          }
        },
      },

      // stores the foreign exchange rate at the time of transaction between donation currency and transaction currency
      // amountInCollectiveCurrency * hostCurrencyFxRate = amountInHostCurrency
      // Expense amount * hostCurrencyFxRate = amountInHostCurrency
      hostCurrencyFxRate: DataTypes.FLOAT,

      // amount in currency of the host
      amountInHostCurrency: DataTypes.INTEGER,
      platformFeeInHostCurrency: DataTypes.INTEGER,
      hostFeeInHostCurrency: DataTypes.INTEGER,
      paymentProcessorFeeInHostCurrency: DataTypes.INTEGER,
      netAmountInCollectiveCurrency: DataTypes.INTEGER, // stores the net amount received by the collective (after fees) or removed from the collective (including fees)

      data: DataTypes.JSON,

      // Note: Not a foreign key, should have been lower case t, 'transactionGroup`
      TransactionGroup: {
        type: DataTypes.UUID,
      },

      RefundTransactionId: {
        type: DataTypes.INTEGER,
        references: { model: 'Transactions', key: 'id' },
      },

      createdAt: {
        type: DataTypes.DATE,
        defaultValue: Sequelize.NOW,
      },

      deletedAt: {
        type: DataTypes.DATE,
      },
    },
    {
      paranoid: true,

      getterMethods: {
        netAmountInHostCurrency() {
          return (
            this.amountInHostCurrency +
            this.paymentProcessorFeeInHostCurrency +
            this.platformFeeInHostCurrency +
            this.hostFeeInHostCurrency
          );
        },

        amountSentToHostInHostCurrency() {
          return (
            this.amountInHostCurrency +
            this.paymentProcessorFeeInHostCurrency +
            this.platformFeeInHostCurrency
          );
        },

        // Info.
        info() {
          return {
            id: this.id,
            uuid: this.uuid,
            type: this.type,
            description: this.description,
            amount: this.amount,
            currency: this.currency,
            createdAt: this.createdAt,
            CreatedByUserId: this.CreatedByUserId,
            FromCollectiveId: this.FromCollectiveId,
            CollectiveId: this.CollectiveId,
            platformFee: this.platformFee,
            hostFee: this.hostFee,
            paymentProcessorFeeInHostCurrency: this
              .paymentProcessorFeeInHostCurrency,
            amountInHostCurrency: this.amountInHostCurrency,
            netAmountInCollectiveCurrency: this.netAmountInCollectiveCurrency,
            netAmountInHostCurrency: this.netAmountInHostCurrency,
            amountSentToHostInHostCurrency: this.amountSentToHostInHostCurrency,
            hostCurrency: this.hostCurrency,
          };
        },
      },

      hooks: {
        afterCreate: transaction => {
          Transaction.createActivity(transaction);
          Transaction.postTransactionToLedger(transaction);
          // intentionally returns null, needs to be async (https://github.com/petkaantonov/bluebird/blob/master/docs/docs/warning-explanations.md#warning-a-promise-was-created-in-a-handler-but-was-not-returned-from-it)
          return null;
        },
      },
    },
  );

  /**
   * Instance Methods
   */
  Transaction.prototype.getUser = function() {
    return models.User.findById(this.CreatedByUserId);
  };

  Transaction.prototype.getHostCollective = async function() {
    let HostCollectiveId = this.HostCollectiveId;
    // if the transaction is from the perspective of the fromCollective
    if (!HostCollectiveId) {
      const fromCollective = await models.Collective.findById(
        this.FromCollectiveId,
      );
      HostCollectiveId = await fromCollective.getHostCollectiveId();
    }
    return models.Collective.findById(HostCollectiveId);
  };

  Transaction.prototype.getExpenseForViewer = function(viewer) {
    return models.Expense.findOne({ where: { id: this.ExpenseId } }).then(
      expense => {
        if (!expense) return null;
        if (viewer && viewer.isAdmin(this.CollectiveId)) return expense.info;
        if (viewer && viewer.id === expense.UserId) return expense.info;
        return expense.public;
      },
    );
  };

  Transaction.prototype.getSource = function() {
    if (this.OrderId) return this.getOrder({ paranoid: false });
    if (this.ExpenseId) return this.getExpense({ paranoid: false });
  };

  Transaction.prototype.getDetailsForUser = function(user) {
    return user.populateRoles().then(() => {
      if (
        user.isAdmin(this.FromCollectiveId) ||
        user.isAdmin(this.CollectiveId) ||
        user.isRoot()
      ) {
        return this.uuid;
      } else {
        return null;
      }
    });
  };

  Transaction.prototype.getRefundTransaction = function() {
    if (!this.RefundTransactionId) return null;
    return Transaction.findById(this.RefundTransactionId);
  };

  /**
   * Class Methods
   */
  Transaction.createMany = (transactions, defaultValues) => {
    return Promise.map(transactions, transaction => {
      for (const attr in defaultValues) {
        transaction[attr] = defaultValues[attr];
      }
      return Transaction.create(transaction);
    }).catch(console.error);
  };

  Transaction.createManyDoubleEntry = (transactions, defaultValues) => {
    return Promise.map(transactions, transaction => {
      for (const attr in defaultValues) {
        transaction[attr] = defaultValues[attr];
      }
      return Transaction.createDoubleEntry(transaction);
    }).catch(console.error);
  };

  Transaction.exportCSV = (transactions, collectivesById) => {
    const getColumnName = attr => {
      if (attr === 'CollectiveId') return 'collective';
      if (attr === 'Expense.privateMessage') return 'private note';
      else return attr;
    };

    const processValue = (attr, value) => {
      if (attr === 'CollectiveId') return get(collectivesById[value], 'slug');
      if (attr === 'createdAt') return moment(value).format('YYYY-MM-DD');
      if (
        [
          'amount',
          'netAmountInCollectiveCurrency',
          'paymentProcessorFeeInHostCurrency',
          'hostFeeInHostCurrency',
          'platformFeeInHostCurrency',
          'netAmountInHostCurrency',
        ].indexOf(attr) !== -1
      ) {
        return value / 100; // converts cents
      }
      return value;
    };

    return exportToCSV(
      transactions,
      [
        'id',
        'createdAt',
        'type',
        'CollectiveId',
        'amount',
        'currency',
        'description',
        'netAmountInCollectiveCurrency',
        'hostCurrency',
        'hostCurrencyFxRate',
        'paymentProcessorFeeInHostCurrency',
        'hostFeeInHostCurrency',
        'platformFeeInHostCurrency',
        'netAmountInHostCurrency',
        'Expense.privateMessage',
      ],
      getColumnName,
      processValue,
    );
  };

  /**
   * Create the opposite transaction from the perspective of the FromCollective
   * There is no fees
   * @POST Two transactions are created. Returns the initial transaction FromCollectiveId -> CollectiveId
   *
   * Examples (simplified with rounded numbers):
   * - Expense1 from User1 paid by Collective1
   *   - amount: $10
   *   - PayPal Fees: $1
   *   - Host Fees: $0
   *   - Platform Fees: $0
   *   => DEBIT: Collective: C1, FromCollective: U1
   *      amount: -$10, netAmountInCollectiveCurrency: -$11, paymentProcessorFeeInHostCurrency: -$1, platformFeeInHostCurrency: 0, hostFeeInHostCurrency: 0
   *   => CREDIT: Collective: U1, FromCollective: C1
   *      amount: $11, netAmountInCollectiveCurrency: $10, paymentProcessorFeeInHostCurrency: -$1, platformFeeInHostCurrency: 0, hostFeeInHostCurrency: 0
   *
   * - Donation1 from User1 to Collective1
   *   - amount: $10
   *   - Stripe Fees: $1
   *   - Host Fees: $1
   *   - Platform Fees: $1
   *   => DEBIT: Collective: U1, FromCollective: C1
   *      amount: -$7, netAmountInCollectiveCurrency: -$10, paymentProcessorFeeInHostCurrency: -$1, platformFeeInHostCurrency: -$1, hostFeeInHostCurrency: -$1
   *   => CREDIT: Collective: C1, FromCollective: U1
   *      amount: $10, netAmountInCollectiveCurrency: $7, paymentProcessorFeeInHostCurrency: -$1, platformFeeInHostCurrency: -$1, hostFeeInHostCurrency: -$1
   *
   * Note:
   * We should simplify a Transaction to:
   * CollectiveId, DEBIT/CREDIT, amount, currency, OrderId where amount is always the net amount in the currency of CollectiveId
   * and we should move paymentProcessorFee, platformFee, hostFee to the Order model
   *
   */

  Transaction.createDoubleEntry = async transaction => {
    transaction.type =
      transaction.amount > 0 ? TransactionTypes.CREDIT : TransactionTypes.DEBIT;
    transaction.netAmountInCollectiveCurrency =
      transaction.netAmountInCollectiveCurrency || transaction.amount;
    transaction.TransactionGroup = uuidv4();
    transaction.hostCurrencyFxRate = transaction.hostCurrencyFxRate || 1;

    const oppositeTransaction = {
      ...transaction,
      type:
        -transaction.amount > 0
          ? TransactionTypes.CREDIT
          : TransactionTypes.DEBIT,
      FromCollectiveId: transaction.CollectiveId,
      CollectiveId: transaction.FromCollectiveId,
      HostCollectiveId: await models.Collective.getHostCollectiveId(
        transaction.FromCollectiveId,
      ), // see https://github.com/opencollective/opencollective/issues/1154
      amount: -transaction.netAmountInCollectiveCurrency,
      netAmountInCollectiveCurrency: -transaction.amount,
      amountInHostCurrency:
        -transaction.netAmountInCollectiveCurrency *
        transaction.hostCurrencyFxRate,
      hostFeeInHostCurrency: transaction.hostFeeInHostCurrency,
      platformFeeInHostCurrency: transaction.platformFeeInHostCurrency,
      paymentProcessorFeeInHostCurrency:
        transaction.paymentProcessorFeeInHostCurrency,
    };

    debug('createDoubleEntry', transaction, 'opposite', oppositeTransaction);

    // We first record the negative transaction
    // and only then we can create the transaction to add money somewhere else
    const transactions = [];
    let index = 0;
    if (transaction.amount < 0) {
      index = 0;
      transactions.push(transaction);
      transactions.push(oppositeTransaction);
    } else {
      index = 1;
      transactions.push(oppositeTransaction);
      transactions.push(transaction);
    }
    return Promise.mapSeries(transactions, t => Transaction.create(t)).then(
      results => results[index],
    );
  };

  Transaction.createFromPayload = ({
    CreatedByUserId,
    FromCollectiveId,
    CollectiveId,
    transaction,
    PaymentMethodId,
  }) => {
    if (!transaction.amount) {
      return Promise.reject(
        new Error('transaction.amount cannot be null or zero'),
      );
    }

    return models.Collective.findById(CollectiveId)
      .then(c => c.getHostCollectiveId())
      .then(HostCollectiveId => {
        if (!HostCollectiveId && !transaction.HostCollectiveId) {
          throw new Error(
            `Cannot create a transaction: collective id ${CollectiveId} doesn't have a host`,
          );
        }
        transaction.HostCollectiveId =
          HostCollectiveId || transaction.HostCollectiveId;
        // attach other objects manually. Needed for afterCreate hook to work properly
        transaction.CreatedByUserId = CreatedByUserId;
        transaction.FromCollectiveId = FromCollectiveId;
        transaction.CollectiveId = CollectiveId;
        transaction.PaymentMethodId =
          transaction.PaymentMethodId || PaymentMethodId;
        transaction.type =
          transaction.amount > 0
            ? TransactionTypes.CREDIT
            : TransactionTypes.DEBIT;
        transaction.platformFeeInHostCurrency = toNegative(
          transaction.platformFeeInHostCurrency,
        );
        transaction.hostFeeInHostCurrency = toNegative(
          transaction.hostFeeInHostCurrency,
        );
        transaction.paymentProcessorFeeInHostCurrency = toNegative(
          transaction.paymentProcessorFeeInHostCurrency,
        );

        if (transaction.amount > 0 && transaction.hostCurrencyFxRate) {
          // populate netAmountInCollectiveCurrency for donations
          const fees =
            transaction.platformFeeInHostCurrency +
            transaction.hostFeeInHostCurrency +
            transaction.paymentProcessorFeeInHostCurrency;
          transaction.netAmountInCollectiveCurrency = Math.round(
            (transaction.amountInHostCurrency + fees) /
              transaction.hostCurrencyFxRate,
          );
        }
        return Transaction.createDoubleEntry(transaction);
      });
  };

  Transaction.createActivity = transaction => {
    if (transaction.deletedAt) {
      return Promise.resolve();
    }
    return (
      Transaction.findById(transaction.id, {
        include: [
          { model: models.Collective, as: 'fromCollective' },
          { model: models.Collective, as: 'collective' },
          { model: models.User, as: 'createdByUser' },
          { model: models.PaymentMethod },
        ],
      })
        // Create activity.
        .then(transaction => {
          const activityPayload = {
            type: activities.COLLECTIVE_TRANSACTION_CREATED,
            TransactionId: transaction.id,
            CollectiveId: transaction.CollectiveId,
            CreatedByUserId: transaction.CreatedByUserId,
            data: {
              transaction: transaction.info,
              user: transaction.User && transaction.User.minimal,
              fromCollective:
                transaction.fromCollective &&
                transaction.fromCollective.minimal,
              collective:
                transaction.collective && transaction.collective.minimal,
            },
          };
          if (transaction.createdByUser) {
            activityPayload.data.user = transaction.createdByUser.info;
          }
          if (transaction.PaymentMethod) {
            activityPayload.data.paymentMethod = transaction.PaymentMethod.info;
          }
          return models.Activity.create(activityPayload);
        })
        .catch(err =>
          console.error(
            `Error creating activity of type ${
              activities.COLLECTIVE_TRANSACTION_CREATED
            } for transaction ID ${transaction.id}`,
            err,
          ),
        )
    );
  };

  const getTransactionToLedgerNestedProperties = async (transaction) => {
    // f.slug as "fromCollectiveSlug",
    if (transaction.FromCollectiveId) {
      const fromCollective = await models.Collective.findById(transaction.FromCollectiveId);
      transaction.fromCollectiveSlug = fromCollective.slug;
    }
    if (transaction.CollectiveId) {
      const collective = await models.Collective.findById(transaction.CollectiveId);
      transaction.collectiveSlug = collective.slug;
    }
    if (transaction.HostCollectiveId) {
      const hostCollective = await models.Collective.findById(transaction.HostCollectiveId);
      transaction.hostCollectiveSlug = hostCollective.slug;
    }
    if (transaction.HostCollectiveId) {
      const paymentMethod = await models.PaymentMethod.findById(transaction.PaymentMethodId);
      transaction.paymentMethodService = paymentMethod.service;
      transaction.paymentMethodType = paymentMethod.type;
      if (paymentMethod.CollectiveId) {
        transaction.paymentMethodCollectiveId = paymentMethod.CollectiveId;
        const pmCollective = await models.Collective.findById(paymentMethod.CollectiveId);
        transaction.paymentMethodCollectiveSlug = pmCollective.slug;
      }
    }
    if (transaction.OrderId) {
      const order = await models.Order.findById(transaction.OrderId);
      if (order.FromCollectiveId) {
        transaction.orderFromCollectiveId = order.FromCollectiveId;
        const orderFromCollective = await models.Collective.findById(order.FromCollectiveId);
        transaction.orderFromCollectiveSlug = orderFromCollective.slug;
      }
      if (order.PaymentMethodId) {
        const orderPaymentMethod = await models.PaymentMethod.findById(order.PaymentMethodId);
        transaction.orderPaymentMethodService = orderPaymentMethod.service;
        transaction.orderPaymentMethodType = orderPaymentMethod.type;
        if (orderPaymentMethod.CollectiveId) {
          transaction.orderPaymentMethodCollectiveId = orderPaymentMethod.CollectiveId;
          const orderPaymentMethodCollective = await models.Collective.findById(orderPaymentMethod.CollectiveId);
          transaction.orderPaymentMethodCollectiveSlug = orderPaymentMethodCollective.slug;
        }
      }
    }
    if (transaction.ExpenseId) {
      const expense = await models.Expense.findById(transaction.ExpenseId);
      transaction.expensePayoutMethod = expense.payoutMethod;
      if (expense.UserId) {
        transaction.expenseUserId = expense.UserId;
        const expenseUser = await models.User.findById(expense.UserId);
        transaction.expenseUserPaypalEmail = expenseUser.paypalEmail;
        if (expenseUser.CollectiveId) {
          const expenseUserCollective = await models.Collective.findById(expenseUser.CollectiveId);
          transaction.expenseUserCollectiveSlug = expenseUserCollective.slug;
        }
      }
      if (expense.CollectiveId) {
        const expenseCollective = await models.Collective.findById(expense.CollectiveId);
        transaction.expenseCollectiveId = expense.CollectiveId;
        transaction.expenseCollectiveSlug = expenseCollective.slug;
      }
    }
    return transaction;
  };

  Transaction.postTransactionToLedger = async (transaction) => {
    if (transaction.deletedAt || transaction.type !== 'CREDIT' || !transaction.PaymentMethodId) {
      return Promise.resolve();
    }
    try {
      transaction = await getTransactionToLedgerNestedProperties(transaction);
      // We define all properties of the new ledger here, except for all wallets(from, to, and fees)
      // and the WalletProvider and PaymentProvider Account ids
      const hostCurrency = transaction.hostCurrency || transaction.currency;
      const amountInHostCurrency = transaction.amountInHostCurrency || transaction.amount;
      // Fees are negative in DEBIT transactions...
      const hostFeeInHostCurrency = -1 * transaction.hostFeeInHostCurrency;
      const platformFeeInHostCurrency = -1 * transaction.platformFeeInHostCurrency;
      const paymentProcessorFeeInHostCurrency = -1 * transaction.paymentProcessorFeeInHostCurrency;
      const ledgerTransaction = {
        FromAccountId: transaction.FromCollectiveId,
        ToAccountId:  transaction.CollectiveId,
        amount: amountInHostCurrency,
        currency: hostCurrency,
        // destinationAmount: transaction.amount, // ONLY for FOREX transactions(currency != hostCurrency)
        // destinationCurrency: transaction.currency, // ONLY for FOREX transactions(currency != hostCurrency)
        walletProviderFee: hostFeeInHostCurrency,
        platformFee: platformFeeInHostCurrency,
        paymentProviderFee: paymentProcessorFeeInHostCurrency,
        LegacyTransactionId: transaction.id,
        forexRate: transaction.hostCurrencyFxRate,
      };
      // setting toWallet
      ledgerTransaction.toWallet = {
        currency: hostCurrency,
        AccountId: transaction.CollectiveId,
      };
      if (transaction.HostCollectiveId) {
        // setting toWallet properties
        ledgerTransaction.toWallet.name = `owner: ${transaction.hostCollectiveSlug}, account: ${transaction.collectiveSlug}, ${hostCurrency}`;
        ledgerTransaction.toWallet.OwnerAccountId = transaction.HostCollectiveId;
        // if there is HostCollectiveId and hostFeeInHostCurrency, so we add the Wallet Provider
        // according to the Host Collective properties
        if (hostFeeInHostCurrency > 0) {
          ledgerTransaction.walletProviderFee = hostFeeInHostCurrency;
          ledgerTransaction.WalletProviderAccountId = transaction.HostCollectiveId;
          ledgerTransaction.walletProviderWallet = {
            name: `owner and account: ${transaction.hostCollectiveSlug}, multi-currency`,
            currency: null,
            AccountId: transaction.HostCollectiveId,
            OwnerAccountId: transaction.HostCollectiveId,
          };
        }
      } else {
        // setting toWallet properties in case there's no host fees
        ledgerTransaction.toWallet.name = `owner: ${transaction.collectiveSlug}, account: ${transaction.collectiveSlug}, ${hostCurrency}`;
        ledgerTransaction.toWallet.OwnerAccountId = transaction.CollectiveId;
        // if there is No HostCollectiveId but there ishostFeeInHostCurrency,
        // We add the wallet provider through either the ExpenseId or OrderId
        if (hostFeeInHostCurrency > 0) {
          ledgerTransaction.walletProviderFee = hostFeeInHostCurrency;
          if (transaction.ExpenseId) {
            // setting toWallet properties in case there's host fees through an Expense
            ledgerTransaction.toWallet.name = `owner: ${transaction.expensePayoutMethod}(through ${transaction.expenseUserPaypalEmail}), account: ${transaction.collectiveSlug}, ${hostCurrency}`;
            ledgerTransaction.toWallet.OwnerAccountId = `payment method: ${transaction.expensePayoutMethod}, paypal email: ${transaction.expenseUserPaypalEmail}`;
            // setting wallet provider wallet
            ledgerTransaction.WalletProviderAccountId = `payment method: ${transaction.expensePayoutMethod}, paypal email: ${transaction.expenseUserPaypalEmail}`;
            ledgerTransaction.walletProviderWallet = {
              name: `owner and account: ${transaction.expensePayoutMethod}(through ${transaction.expenseUserPaypalEmail}), multi-currency`,
              currency: transaction.expenseCurrency,
              AccountId: `payment method: ${transaction.expensePayoutMethod}, paypal email: ${transaction.expenseUserPaypalEmail}`,
              OwnerAccountId: `payment method: ${transaction.expensePayoutMethod}, paypal email: ${transaction.expenseUserPaypalEmail}`,
            };
          } else { // Order
            // setting toWallet properties in case there's host fees through an Expense
            ledgerTransaction.toWallet.name = `owner: ${transaction.orderPaymentMethodCollectiveSlug}(Order), account: ${transaction.collectiveSlug}, ${hostCurrency}`;
            ledgerTransaction.toWallet.OwnerAccountId = `${transaction.orderPaymentMethodCollectiveSlug}(Order)`;
            // setting wallet provider wallet
            ledgerTransaction.WalletProviderAccountId = `${transaction.orderPaymentMethodCollectiveSlug}(Order)`;
            ledgerTransaction.walletProviderWallet = {
              name: `owner and account: ${transaction.orderPaymentMethodCollectiveSlug}(Order), multi-currency`,
              currency: null,
              AccountId: `${transaction.orderPaymentMethodCollectiveSlug}(Order)`,
              OwnerAccountId: `${transaction.orderPaymentMethodCollectiveSlug}(Order)`,
            };
          }
        }
      }
      // setting fromWallet
      ledgerTransaction.fromWallet = {
        name: '',
        currency: hostCurrency,
        AccountId: transaction.FromCollectiveId,
        PaymentMethodId: transaction.PaymentMethodId || null,
        ExpenseId: transaction.ExpenseId || null,
        OrderId: transaction.OrderId || null,
      };
      // setting from and payment provider wallets
      if (transaction.PaymentMethodId) {
        ledgerTransaction.fromWallet.name = `owner: ${transaction.paymentMethodCollectiveSlug}, account: ${transaction.fromCollectiveSlug}, ${hostCurrency}`;
        ledgerTransaction.fromWallet.OwnerAccountId = transaction.paymentMethodCollectiveId;
        // creating Payment Provider wallet
        ledgerTransaction.PaymentProviderAccountId = transaction.paymentMethodService;
        ledgerTransaction.paymentProviderWallet = {
          name: transaction.paymentMethodType,
          currency: null,
          AccountId: transaction.paymentMethodService,
          OwnerAccountId: transaction.paymentMethodService,
          PaymentMethodId: transaction.PaymentMethodId,
        };
      } else if (transaction.ExpenseId) {
        ledgerTransaction.fromWallet.name = `owner: ${transaction.expenseCollectiveSlug}, account: ${transaction.fromCollectiveSlug}, ${hostCurrency}`;
        ledgerTransaction.fromWallet.OwnerAccountId = transaction.expenseCollectiveId;
        ledgerTransaction.PaymentProviderAccountId = transaction.expensePayoutMethod;
        ledgerTransaction.paymentProviderWallet = {
          name: `owner and account: ${transaction.expensePayoutMethod}, multi-currency`,
          currency: null,
          AccountId: transaction.expensePayoutMethod,
          OwnerAccountId: transaction.expensePayoutMethod,
          ExpenseId: transaction.ExpenseId,
        };
      } else { // If there is no PaymentMethodId nor ExpenseId, there will be OrderId
        // Order has PaymentMethod, then the slug will come from the transaction.order.paymentmethod
        // otherwise we will consider transaction.order.fromCollective as the owner
        if (transaction.orderPaymentMethodCollectiveSlug) {
          ledgerTransaction.fromWallet.name = `owner: ${transaction.orderPaymentMethodCollectiveSlug}, account: ${transaction.fromCollectiveSlug}, ${hostCurrency}`;
          ledgerTransaction.fromWallet.OwnerAccountId = transaction.orderPaymentMethodCollectiveId;
          ledgerTransaction.PaymentProviderAccountId = `${transaction.orderPaymentMethodCollectiveId}_${transaction.orderPaymentMethodService}_${transaction.orderPaymentMethodType}`;
          ledgerTransaction.paymentProviderWallet = {
            name: `account and owner:${transaction.orderPaymentMethodCollectiveId}, service: ${transaction.orderPaymentMethodService}, type: ${transaction.orderPaymentMethodType}`,
            currency: null,
            AccountId: `${transaction.orderPaymentMethodCollectiveId}_${transaction.orderPaymentMethodService}_${transaction.orderPaymentMethodType}`,
            OwnerAccountId: `${transaction.orderPaymentMethodCollectiveId}_${transaction.orderPaymentMethodService}_${transaction.orderPaymentMethodType}`,
            OrderId: transaction.OrderId,
          };
        } else {
          ledgerTransaction.fromWallet.name = `owner: ${transaction.orderFromCollectiveSlug}, account: ${transaction.fromCollectiveSlug}, ${hostCurrency}`;
          ledgerTransaction.fromWallet.OwnerAccountId = transaction.orderFromCollectiveId;
          ledgerTransaction.PaymentProviderAccountId = `${transaction.orderFromCollectiveId}_${transaction.OrderId}`;
          ledgerTransaction.paymentProviderWallet = {
            name: `from ${transaction.orderFromCollectiveSlug}(Order id ${transaction.OrderId})`,
            currency: null,
            AccountId: `${transaction.orderFromCollectiveId}_${transaction.OrderId}`,
            OwnerAccountId: `${transaction.orderFromCollectiveId}_${transaction.OrderId}`,
            OrderId: transaction.OrderId,
          };
        }
      }
      const ledgerUrlResult = await axios.post(ledger.postTransactionUrl, ledgerTransaction);
      return ledgerUrlResult;
    } catch (error) {
      console.error(error);
      throw error;
    }
  };

  return Transaction;
};
