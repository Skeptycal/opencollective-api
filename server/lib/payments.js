/** @module lib/payments */

import Promise from 'bluebird';
import { includes, pick, get, find } from 'lodash';
import { Op } from 'sequelize';

import models from '../models';
import emailLib from './email';
import { types } from '../constants/collectives';
import status from '../constants/order_status';
import activities from '../constants/activities';
import paymentProviders from '../paymentProviders';
import * as libsubscription from './subscriptions';
import * as libtransactions from './transactions';
import { getRecommendedCollectives } from './data';

/** Check if paymentMethod has a given fully qualified name
 *
 * Payment Provider names are composed by service and type joined with
 * a dot. E.g.: `opencollective.giftcard`, `stripe.creditcard`,
 * etc. This function returns true if a *paymentMethod* instance has a
 * given *fqn*.
 *
 * @param {String} fqn is the fully qualified name to be matched.
 * @param {models.PaymentMethod} paymentMethod is the instance that
 *  will have the fully qualified name compared to the parameter
 *  *fqn*.
 * @returns {Boolean} true if *paymentMethod* has a fully qualified
 *  name that equals *fqn*.
 * @example
 * > isProvider('opencollective.giftcard', { service: 'foo', type: 'bar' })
 * false
 * > isProvider('stripe.creditcard', { service: 'stripe', type: 'creditcard' })
 * true
 */
export function isProvider(fqn, paymentMethod) {
  const pmFqn = `${paymentMethod.service}.${paymentMethod.type || 'default'}`;
  return fqn === pmFqn;
}

/** Find payment method handler
 *
 * @param {models.PaymentMethod} paymentMethod This must point to a row in the
 *  `PaymentMethods` table. That information is retrieved and the
 *  fields `service' & `type' are used to figure out which payment
 *  {service: 'stripe', type: 'bitcoin'}.
 * @return the payment method's JS module.
 */
export function findPaymentMethodProvider(paymentMethod) {
  const provider = paymentMethod ? paymentMethod.service : 'manual';
  const methodType = paymentMethod.type || 'default';
  let paymentMethodProvider = paymentProviders[provider];
  if (!paymentMethodProvider) {
    throw new Error(`No payment provider found for ${this.service}`);
  }
  paymentMethodProvider = paymentMethodProvider.types[methodType]; // eslint-disable-line import/namespace
  if (!paymentMethodProvider) {
    throw new Error(
      `No payment provider found for ${this.service}:${this.type}`,
    );
  }
  return paymentMethodProvider;
}

/** Process an order using its payment information
 *
 * @param {Object} order must contain a valid `paymentMethod`
 *  field. Which means that the query to select the order must include
 *  the `PaymentMethods` table.
 */
export async function processOrder(order, options) {
  const paymentMethod = findPaymentMethodProvider(order.paymentMethod);
  return await paymentMethod.processOrder(order, options);
}

/** Refund a transaction
 *
 * @param {Object} transaction must contain a valid `PaymentMethod`
 *  field. Which means that the query to select it from the DB must
 *  include the `PaymentMethods` table.
 * @param {Object} user is an instance of the User model that will be
 *  associated to the refund transaction as who performed the refund.
 */
export async function refundTransaction(transaction, user) {
  const paymentMethod = findPaymentMethodProvider(transaction.PaymentMethod);
  return await paymentMethod.refundTransaction(transaction, user);
}

/** Calculates how much an amount's fee is worth.
 *
 * @param {Number} amount is the amount of the transaction.
 * @param {Number} fee is the percentage of the transaction.
 * @example
 * calcFee(100, 3.5); // 4.0
 * @return {Number} fee-percent of the amount rounded
 */
export function calcFee(amount, fee) {
  return Math.round((amount * fee) / 100);
}

/** Create refund transactions
 *
 * This function creates the negative transactions after refunding an
 * existing transaction.
 *
 * If a CREDIT transaction from collective A to collective B is
 * received. Two new transactions are created:
 *
 *   1. CREDIT from collective B to collective A
 *   2. DEBIT from collective A to collective B
 *
 * @param {models.Transaction} transaction Can be either a
 *  DEBIT or a CREDIT transaction and it will generate a pair of
 *  transactions that debit the collective that was credited and
 *  credit the user that was debited.
 * @param {number} refundedPaymentProcessorFee is the amount refunded
 *  by the payment processor. If it's 0 (zero) it means that the
 *  payment processor didn't refund its fee at all. In that case, the
 *  equivalent value will be moved from the host so the user can get
 *  the full refund.
 * @param {Object} data contains the information from the payment
 *  method that should be saved within the *data* field of the
 *  transactions being created.
 */
export async function createRefundTransaction(
  transaction,
  refundedPaymentProcessorFee,
  data,
  user,
) {
  /* If the transaction passed isn't the one from the collective
   * perspective, the opposite transaction is retrieved. */
  const collectiveLedger =
    transaction.type === 'CREDIT'
      ? transaction
      : await models.Transaction.find({
          where: {
            TransactionGroup: transaction.TransactionGroup,
            id: { [Op.ne]: transaction.id },
          },
        });
  const userLedgerRefund = pick(collectiveLedger, [
    'FromCollectiveId',
    'CollectiveId',
    'HostCollectiveId',
    'PaymentMethodId',
    'OrderId',
    'hostCurrencyFxRate',
    'hostCurrency',
    'hostFeeInHostCurrency',
    'platformFeeInHostCurrency',
    'paymentProcessorFeeInHostCurrency',
  ]);
  userLedgerRefund.CreatedByUserId = user.id;
  userLedgerRefund.description = `Refund of "${transaction.description}"`;
  userLedgerRefund.data = data;

  /* The refund operation moves back fees to the user's ledger so the
   * fees there should be positive. Since they're usually in negative,
   * we're just setting them to positive by adding a - sign in front
   * of it. */
  userLedgerRefund.hostFeeInHostCurrency = -userLedgerRefund.hostFeeInHostCurrency;
  userLedgerRefund.platformFeeInHostCurrency = -userLedgerRefund.platformFeeInHostCurrency;
  userLedgerRefund.paymentProcessorFeeInHostCurrency = -userLedgerRefund.paymentProcessorFeeInHostCurrency;

  /* If the payment processor doesn't refund the fee, the equivalent
   * of the fee will be transferred from the host to the user so the
   * user can get the full refund. */
  if (refundedPaymentProcessorFee === 0) {
    userLedgerRefund.hostFeeInHostCurrency +=
      userLedgerRefund.paymentProcessorFeeInHostCurrency;
    userLedgerRefund.paymentProcessorFeeInHostCurrency = 0;
  }

  /* Amount fields. Must be calculated after tweaking all the fees */
  userLedgerRefund.amount = -collectiveLedger.amount;
  userLedgerRefund.amountInHostCurrency = -collectiveLedger.amountInHostCurrency;
  userLedgerRefund.netAmountInCollectiveCurrency = -libtransactions.netAmount(
    collectiveLedger,
  );

  return models.Transaction.createDoubleEntry(userLedgerRefund);
}

export async function associateTransactionRefundId(transaction, refund) {
  const [tr1, tr2, tr3, tr4] = await models.Transaction.findAll({
    order: ['id'],
    where: {
      [Op.or]: [
        { TransactionGroup: transaction.TransactionGroup },
        { TransactionGroup: refund.TransactionGroup },
      ],
    },
  });

  tr1.RefundTransactionId = tr4.id;
  await tr1.save(); // User Ledger
  tr2.RefundTransactionId = tr3.id;
  await tr2.save(); // Collective Ledger
  tr3.RefundTransactionId = tr2.id;
  await tr3.save(); // Collective Ledger
  tr4.RefundTransactionId = tr1.id;
  await tr4.save(); // User Ledger

  // We need to return the same transactions we received because the
  // graphql mutation needs it to return to the user. However we have
  // to return the updated instances, not the ones we received.
  return find([tr1, tr2, tr3, tr4], { id: transaction.id });
}

/**
 * Execute an order as user using paymentMethod
 * Note: validation of the paymentMethod happens in `models.Order.setPaymentMethod`. Not here anymore.
 * @param {Object} order { tier, description, totalAmount, currency, interval (null|month|year), paymentMethod }
 * @param {Object} options { hostFeePercent, platformFeePercent} (only for add funds and if remoteUser is admin of host or root)
 */
export const executeOrder = (user, order, options) => {
  if (!(order instanceof models.Order)) {
    return Promise.reject(
      new Error('order should be an instance of the Order model'),
    );
  }
  if (!order) {
    return Promise.reject(new Error('No order provided'));
  }
  if (order.processedAt) {
    return Promise.reject(
      new Error(
        `This order (#${order.id}) has already been processed at ${
          order.processedAt
        }`,
      ),
    );
  }

  const payment = {
    amount: order.totalAmount,
    interval: order.interval,
    currency: order.currency,
  };

  try {
    validatePayment(payment);
  } catch (error) {
    return Promise.reject(error);
  }

  return order
    .populate()
    .then(() => {
      if (payment.interval) {
        // @lincoln: shouldn't this section be executed after we successfully charge the user for the first payment? (ie. after `processOrder`)
        return order
          .getSubscription({ rejectOnEmpty: true })
          .catch(() => models.Subscription.create(payment))
          .then(subscription => {
            // The order instance doesn't have the Subscription field
            // here because it was just created and no models were
            // included so we're doing that manually here. Not the
            // cutest but works.
            order.Subscription = subscription;
            const updatedDates = libsubscription.getNextChargeAndPeriodStartDates(
              'new',
              order,
            );
            order.Subscription.nextChargeDate = updatedDates.nextChargeDate;
            order.Subscription.nextPeriodStart =
              updatedDates.nextPeriodStart ||
              order.Subscription.nextPeriodStart;

            // Both subscriptions and one time donations are charged
            // immediatelly and there won't be a better time to update
            // this field after this. Please notice that it will change
            // when the issue #729 is tackled.
            // https://github.com/opencollective/opencollective/issues/729
            order.Subscription.chargeNumber = 1;
            return subscription.save();
          })
          .then(subscription => {
            return order.update({ SubscriptionId: subscription.id });
          });
      }
      return null;
    })
    .then(() => {
      return processOrder(order, options)
        .tap(() =>
          order.update({
            status: order.SubscriptionId ? status.ACTIVE : status.PAID,
          }),
        )
        .tap(async () => {
          if (!order.matchingFund) return null;
          const matchingFundCollective = await models.Collective.findById(
            order.matchingFund.CollectiveId,
          );
          // if there is a matching fund, we execute the order
          // also adds the owner of the matching fund as a BACKER of collective
          const matchingOrder = {
            ...pick(order, ['id', 'collective', 'tier', 'currency']),
            totalAmount: order.totalAmount * order.matchingFund.matching,
            paymentMethod: order.matchingFund,
            FromCollectiveId: order.matchingFund.CollectiveId,
            fromCollective: matchingFundCollective,
            description: `Matching ${order.matchingFund.matching}x ${
              order.fromCollective.name
            }'s donation`,
            createdByUser: await matchingFundCollective.getUser(),
          };

          // processOrder expects an update function to update `order.processedAt`
          matchingOrder.update = () => {};

          return paymentProviders[order.paymentMethod.service].types[
            order.paymentMethod.type || 'default'
          ]
            .processOrder(matchingOrder, options) // eslint-disable-line import/namespace
            .then(transaction => {
              sendOrderConfirmedEmail({ ...order, transaction }); // async
              return null;
            });
        });
    })
    .then(transaction => {
      // for gift cards
      if (
        !transaction &&
        isProvider('opencollective.giftcard', order.paymentMethod)
      ) {
        sendOrderProcessingEmail(order).then(() =>
          sendSupportEmailForManualIntervention(order),
        ); // async
      } else if (
        !transaction &&
        order.paymentMethod.service === 'stripe' &&
        order.paymentMethod.type === 'bitcoin'
      ) {
        sendOrderProcessingEmail(order); // async
      } else {
        order.transaction = transaction;
        sendOrderConfirmedEmail(order); // async
      }
      return transaction;
    })
    .tap(async transaction => {
      // Credit card charges are synchronous. If the transaction is
      // created here it means that the payment went through so it's
      // safe to enable subscriptions after this.
      if (payment.interval && transaction) await order.Subscription.activate();
    });
};

const validatePayment = payment => {
  if (payment.interval && !includes(['month', 'year'], payment.interval)) {
    throw new Error('Interval should be null, month or year.');
  }

  if (!payment.amount) {
    throw new Error('payment.amount missing');
  }

  if (payment.amount < 50) {
    throw new Error('payment.amount must be at least $0.50');
  }
};

const sendOrderConfirmedEmail = async order => {
  const { collective, tier, interval, fromCollective } = order;
  const user = order.createdByUser;

  if (collective.type === types.EVENT) {
    return models.Activity.create({
      type: activities.TICKET_CONFIRMED,
      data: {
        EventCollectiveId: collective.id,
        UserId: user.id,
        recipient: { name: fromCollective.name },
        order: pick(order, [
          'totalAmount',
          'currency',
          'createdAt',
          'quantity',
        ]),
        tier: tier && tier.info,
      },
    });
  } else {
    // normal order
    const relatedCollectives = await order.collective.getRelatedCollectives(
      3,
      0,
    );
    const recommendedCollectives = await getRecommendedCollectives(
      order.collective,
      3,
    );
    const emailOptions = {
      from: `${collective.name} <hello@${collective.slug}.opencollective.com>`,
    };
    const data = {
      order: pick(order, ['totalAmount', 'currency', 'createdAt']),
      transaction: pick(order.transaction, ['createdAt', 'uuid']),
      user: user.info,
      collective: collective.info,
      fromCollective: fromCollective.minimal,
      interval,
      relatedCollectives,
      recommendedCollectives,
      monthlyInterval: interval === 'month',
      firstPayment: true,
      subscriptionsLink:
        interval &&
        user.generateLoginLink(`/${fromCollective.slug}/subscriptions`),
    };

    let matchingFundCollective;
    if (order.matchingFund) {
      matchingFundCollective = await models.Collective.findById(
        order.matchingFund.CollectiveId,
      );
      data.matchingFund = {
        collective: pick(matchingFundCollective, ['slug', 'name', 'image']),
        matching: order.matchingFund.matching,
        amount: order.matchingFund.matching * order.totalAmount,
      };
    }

    // sending the order confirmed email to the matching fund owner or to the donor
    if (
      get(order, 'transaction.FromCollectiveId') ===
      get(order, 'matchingFund.CollectiveId')
    ) {
      const recipients = await matchingFundCollective.getEmails();
      return emailLib.send('donationmatched', recipients, data, emailOptions);
    } else {
      return emailLib.send('thankyou', user.email, data, emailOptions);
    }
  }
};

const sendSupportEmailForManualIntervention = order => {
  const user = order.createdByUser;
  return emailLib.sendMessage(
    'support@opencollective.com',
    'Gift card order needs manual attention',
    null,
    { text: `Order Id: ${order.id} by userId: ${user.id}` },
  );
};

// Assumes one-time payments,
const sendOrderProcessingEmail = order => {
  const { collective, fromCollective } = order;
  const user = order.createdByUser;

  return emailLib.send(
    'processing',
    user.email,
    {
      order: order.info,
      user: user.info,
      collective: collective.info,
      fromCollective: fromCollective.minimal,
      subscriptionsLink: user.generateLoginLink(
        `/${fromCollective.slug}/subscriptions`,
      ),
    },
    {
      from: `${collective.name} <hello@${collective.slug}.opencollective.com>`,
    },
  );
};
