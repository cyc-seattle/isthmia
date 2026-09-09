import { BaseAttributes } from "parse";
import { register, Parse } from "./parse.js";

interface ArchiveAttributes {
  archived?: boolean;
}

interface ClubspotAttributes extends BaseAttributes, ArchiveAttributes {
  clubObject: Club;
}

interface ClubAttributes extends ClubspotAttributes {
  name: string;
}

@register
export class Club extends Parse.Object<ClubAttributes> {
  static objectClass = "clubs";

  constructor(attributes: ClubAttributes) {
    super(Club.objectClass, attributes);
  }
}

interface UserClubAttributes {
  clubObject: Club;
  userObject: Parse.User;

  accepted?: boolean;
  admin?: boolean;
  manager?: boolean;
  permissions?: string[];
}

@register
export class UserClub extends Parse.Object<UserClubAttributes> {
  static objectClass = "user_club";

  constructor(attributes: UserClubAttributes) {
    super(UserClub.objectClass, attributes);
  }
}

// The following are referenced as pointers from several classes below, but haven't had their own
// attributes reverse engineered yet - they're registered so `.include()`d data still deserializes
// into a typed Parse.Object rather than a plain one.

@register
export class StripeAccount extends Parse.Object {
  static objectClass = "stripeAccounts";

  constructor() {
    super(StripeAccount.objectClass);
  }
}

@register
export class Profile extends Parse.Object {
  static objectClass = "profiles";

  constructor() {
    super(Profile.objectClass);
  }
}

@register
export class EntryFee extends Parse.Object {
  static objectClass = "entryFees";

  constructor() {
    super(EntryFee.objectClass);
  }
}

@register
export class RegistrationHold extends Parse.Object {
  static objectClass = "registration_holds";

  constructor() {
    super(RegistrationHold.objectClass);
  }
}

@register
export class Charge extends Parse.Object {
  static objectClass = "charges";

  constructor() {
    super(Charge.objectClass);
  }
}

@register
export class PaymentIntent extends Parse.Object {
  static objectClass = "paymentIntents";

  constructor() {
    super(PaymentIntent.objectClass);
  }
}

@register
export class CustomField extends Parse.Object {
  static objectClass = "customFields";

  constructor() {
    super(CustomField.objectClass);
  }
}

interface BillingRegistrationAttributes extends ClubspotAttributes {
  amount: number;
  amountPending: number;
  amountRefunded: number;
  amount_capturable: number;
  amount_deferred: number;
  amount_received: number;
  application_fee_amount: number;
  deferredAmountBilled?: number;
  discount: number;
  processingFee: number;
  processing_passed_on: number;
  tax: number;
  cartObject?: Cart;
  currency: string;

  registrationObject?: Registration;
  customer?: Customer;
  stripeAccount?: StripeAccount;
}

@register
export class BillingRegistration extends Parse.Object<BillingRegistrationAttributes> {
  static objectClass = "billing_registration";

  constructor(attributes: BillingRegistrationAttributes) {
    super(BillingRegistration.objectClass, attributes);
  }
}

interface QbAccount {
  value: string;
  name: string;
}

interface ChartOfAccountsAttributes extends ArchiveAttributes {
  clubObject: Club;
  name: string;
  code: string;
  accountType?: string; // asset | expense | revenue | liability | equity
  subAccountType?: string;
  specialType?: string; // e.g. "cash", "primaryAR", "transit" - accounts Clubspot manages itself
  disallowEdits?: boolean;
  department?: string;
  qbAccountObject?: QbAccount; // Linked QuickBooks Online account, once accounting sync is set up
}

/**
 * The club's chart of accounts, used both to categorize revenue/expenses and as the accounting
 * sync target for QuickBooks Online. See the Reporting -> Accounting section of the dashboard.
 */
@register
export class ChartOfAccounts extends Parse.Object<ChartOfAccountsAttributes> {
  static objectClass = "chartOfAccounts";

  constructor(attributes: ChartOfAccountsAttributes) {
    super(ChartOfAccounts.objectClass, attributes);
  }
}

interface WelcomeEmail {
  content?: string;
  attachments?: unknown[];
  enabled?: boolean;
}

interface CampAttributes extends ClubspotAttributes {
  name: string;
  description?: string | null;
  note?: string | null;
  startDate?: Date;
  endDate?: Date;
  lastChanceDate?: Date;

  imageURL?: string;
  imageCrop?: string;

  public?: boolean;
  pending?: boolean;
  registration_closed?: boolean;
  hide_spots_left?: boolean | null;

  waitlist_accepted_logic?: boolean;
  waitlist_updates?: string;
  waitlist_payments?: string; // e.g. "deferred"
  deposit_rule?: string;
  deposits?: boolean;
  show_participants_on_signup?: boolean;

  // Location, shown on the public listing.
  email?: string;
  location?: string;
  line1?: string | null;
  line2?: string | null;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;

  // What the registration form collects for each participant - drives what Participant fields
  // will actually be populated for this camp's registrations.
  collect_address?: boolean;
  collect_dob?: boolean;
  collect_gender?: boolean | null;
  collect_insurance?: boolean;
  collect_mobile?: boolean;
  collect_parentGuardian?: boolean;
  collect_parentGuardian_secondary?: boolean;
  collect_pcp?: boolean;
  collect_sailNumber?: boolean | null;
  collect_weight?: boolean | null;
  require_method_on_file?: boolean | null;
  paymentMethods?: unknown | null;
  customFieldsArray?: CustomField[];

  email_welcome?: WelcomeEmail;

  // Housing, used for multi-day/overnight camps.
  housing?: boolean | null;
  housing_approval?: boolean | null;
  housing_startDate?: Date | null;
  housing_endDate?: Date | null;
  housing_lastChanceDate?: Date | null;
  housing_excluded_clubs?: unknown | null;

  membershipConnections?: unknown[];
  connectedClubs?: unknown[];
  cloned_from?: Camp;

  chartOfAccounts?: ChartOfAccounts;
  account_guest_non_member?: ChartOfAccounts;
}

@register
export class Camp extends Parse.Object<CampAttributes> {
  static objectClass = "camps";

  constructor(attributes: CampAttributes) {
    super(Camp.objectClass, attributes);
  }
}

interface CampClassAttributes extends ClubspotAttributes {
  name: string;
  campObject: Camp;

  hidden?: boolean;
  cumulativeEntryCap?: number;

  entryCapsArray?: EntryCap[];
  entryFeesArray?: EntryFee[];
  productObject?: Merch;
  required_waivers?: Waiver[];
  // subclassesArray --> unconfirmed - possibly self-referential (age/skill subdivisions within a class)
  subclassesArray?: unknown[];
}

@register
export class CampClass extends Parse.Object<CampClassAttributes> {
  static objectClass = "campClasses";

  constructor(attributes: CampClassAttributes) {
    super(CampClass.objectClass, attributes);
  }
}

interface CampSessionAttributes extends ClubspotAttributes {
  name: string;
  startDate: Date;
  endDate: Date;
  campObject: Camp;

  allClasses?: boolean;
  campClassesArray?: CampClass[];

  defaultFullCampSession?: boolean;
}

@register
export class CampSession extends Parse.Object<CampSessionAttributes> {
  static objectClass = "campSessions";

  constructor(attributes: CampSessionAttributes) {
    super(CampSession.objectClass, attributes);
  }
}

interface CartAttributes {
  closed?: boolean;
  registrationObject?: Registration;
  userObject: Parse.User;
}

@register
export class Cart extends Parse.Object<CartAttributes> {
  static objectClass = "carts";

  constructor(attributes: CartAttributes) {
    super(Cart.objectClass, attributes);
  }
}

interface CustomerAttributes extends ClubspotAttributes {
  email: string;
  name?: string;
  description?: string;
  phone?: string | null;
  receipt_email?: string;
  balance?: number;
  delinquent?: boolean;
  stripeAccount?: StripeAccount;
  stripeAccountID?: string;
  stripeCustomerID?: string;
  // Stripe's own payment-method objects (card brand/last4/expiry) - not re-typed here since they
  // pass straight through from Stripe rather than being a Clubspot-defined shape.
  payment_methods?: unknown[];
}

@register
export class Customer extends Parse.Object<CustomerAttributes> {
  static objectClass = "customers";

  constructor(attributes: CustomerAttributes) {
    super(Customer.objectClass, attributes);
  }
}

interface EntryCapAttributes extends ArchiveAttributes {
  cap: number;
  campClassObject: CampClass;
  campSessionObject?: CampSession;
}

@register
export class EntryCap extends Parse.Object<EntryCapAttributes> {
  static objectClass = "entryCaps";

  constructor(attributes: EntryCapAttributes) {
    super(EntryCap.objectClass, attributes);
  }
}

interface CustomFieldResponse {
  customFieldID: string;
  response: string;
}

interface ParticipantAttributes extends BaseAttributes {
  registrationObject?: Registration;
  firstName?: string;
  lastName?: string;
  email?: string;
  DOB?: Date;
  gender?: string;
  customFieldsArray?: CustomFieldResponse[];

  mobile?: string;
  medical_allergies?: string;
  medical_meds?: string;
  medical_tetanus?: string;
  medical: string;

  emergencyContact?: string;
  emergencyMobile?: string;
  emergencyRelationship?: string;

  parentGuardianName?: string;
  parentGuardianEmail?: string;
  parentGuardianMobile?: string;

  parentGuardianName_secondary?: string;
  parentGuardianEmail_secondary?: string;
  parentGuardianMobile_secondary?: string;

  member_tbd?: boolean;
  hostMember?: boolean;

  street?: string;
  city?: string;
  state?: string;
  zip?: string;

  profileObject?: Profile;

  // contacts[] / members[] / members_external[] - always observed empty in CSC data so far;
  // shape not yet reverse engineered.
  contactsArray?: unknown[];
  members?: unknown[];
  members_external?: unknown[];
}

@register
export class Participant extends Parse.Object<ParticipantAttributes> {
  static objectClass = "participants";

  constructor(attributes: ParticipantAttributes) {
    super(Participant.objectClass, attributes);
  }

  public get address() {
    const street = this.get("street")?.trim();
    const city = this.get("city")?.trim();
    const state = this.get("state")?.trim();
    const zip = this.get("zip")?.trim();

    return `${street} ${city} ${state} ${zip}`;
  }
}

interface RegistrationAttributes extends ClubspotAttributes {
  application?: boolean;

  // A registration belongs to exactly one of these, depending on what it's registering for.
  campObject?: Camp;
  eventObject?: SocialEvent;
  regattaObject?: Regatta;

  confirmed_at?: Date;

  firstName?: string;
  lastName?: string;

  // Clubspot used to support multiple participants in one registration, but now only support a single participant
  // per registration. So, for most events, there will be a single element in these arrays.
  participantNames?: string[];
  participantsArray?: Participant[];

  status?: string;
  type?: string; // camp | regatta | event
  waiver_status?: "fully_signed" | "signatures_required";

  billing_registration?: BillingRegistration;
  classes?: CampClass[];
  sessions?: CampSession[];
  sessionJoinObjects?: RegistrationCampSession[];
  profilesArray?: Profile[];
  superAdmin?: Parse.User;
  userObjects?: Parse.User[];

  registration_hold?: RegistrationHold;
  hold_expires?: Date;
  hold_timestamp?: number;

  // members[] --> unconfirmed, always observed empty in CSC data so far.
  members?: unknown[];
  // subclassesArray[] --> unconfirmed, same shape question as CampClass.subclassesArray.
  subclassesArray?: unknown[];
}

@register
export class Registration extends Parse.Object<RegistrationAttributes> {
  static objectClass = "registrations";

  constructor(attributes: RegistrationAttributes) {
    super(Registration.objectClass, attributes);
  }
}

interface WaitlistUpdate {
  reason: string;
  timestamp: number;
  waitlist: boolean;
  waitlist_number: number;
}

interface RegistrationCampSessionAttributes extends BaseAttributes, ArchiveAttributes {
  campObject: Camp;
  campSessionObject: CampSession;
  campClassObject: CampClass;
  registrationObject: Registration;

  confirmed_at?: Date;
  status: string;

  priority: number;
  waitlist: boolean;
  waitlistNumber?: number;
  acceptedFromWaitlist?: boolean;
  waitlist_updates?: WaitlistUpdate[];

  // hold --> registration_holds
  // hold_expires
  // hold_timestamp: timestamp
  // held_or_confirmed: timestamp
}

@register
export class RegistrationCampSession extends Parse.Object<RegistrationCampSessionAttributes> {
  static objectClass = "registration_campSession";

  constructor(attributes: RegistrationCampSessionAttributes) {
    super(RegistrationCampSession.objectClass, attributes);
  }
}

// Shifts are used for golf schedules
@register
export class Shift extends Parse.Object {
  static objectClass = "shifts";

  constructor() {
    super(Shift.objectClass);
  }
}

// Golf courses for the club
@register
export class Courses extends Parse.Object {
  static objectClass = "courses";

  constructor() {
    super(Courses.objectClass);
  }
}

//
// Events: social events and regattas. Camps are modeled above; all three share the `registrations`
// class via campObject/eventObject/regattaObject.
//

interface SocialEventAttributes extends ClubspotAttributes {
  name: string;
  startDate?: Date;
  endDate?: Date;
  lastChanceDate?: Date;
  startTime?: string;
  imageURL?: string;
  superAdmin?: Parse.User;
  external_event?: boolean;
  event_product?: boolean;
  events_v2?: boolean;
  calendarOnly?: boolean;
}

@register
export class SocialEvent extends Parse.Object<SocialEventAttributes> {
  static objectClass = "events";

  constructor(attributes: SocialEventAttributes) {
    super(SocialEvent.objectClass, attributes);
  }
}

interface RegattaAttributes extends ClubspotAttributes {
  name: string;
  startDate?: Date;
  endDate?: Date;
  lastChanceDate?: Date;
  imageURL?: string;
  superAdmin?: Parse.User;
  regatta_external?: boolean;
  complete?: boolean;
}

@register
export class Regatta extends Parse.Object<RegattaAttributes> {
  static objectClass = "regattas";

  constructor(attributes: RegattaAttributes) {
    super(Regatta.objectClass, attributes);
  }
}

interface EventTagAttributes extends ArchiveAttributes {
  clubObject: Club;
  name: string;
  hex_value?: string;
  createdBy?: Parse.User;
}

@register
export class EventTag extends Parse.Object<EventTagAttributes> {
  static objectClass = "event_tags";

  constructor(attributes: EventTagAttributes) {
    super(EventTag.objectClass, attributes);
  }
}

interface EventSubtypeAttributes extends ArchiveAttributes {
  clubObject: Club;
  name: string;
  chartOfAccounts?: ChartOfAccounts;
  tax_exempt?: boolean;
}

@register
export class EventSubtype extends Parse.Object<EventSubtypeAttributes> {
  static objectClass = "event_subtypes";

  constructor(attributes: EventSubtypeAttributes) {
    super(EventSubtype.objectClass, attributes);
  }
}

//
// Communication: bulk email/SMS, contact lists, and the SES bounce/unsubscribe suppression list.
//

interface ContactListMembers {
  enabled: boolean;
  filters: unknown[]; // TODO: type filter shape once needed - not yet reverse engineered.
}

interface ContactListAttributes extends ArchiveAttributes {
  clubObject: Club;
  name: string;
  created_by?: Parse.User;
  members?: ContactListMembers;
  // contacts --> not yet modeled as its own class
}

@register
export class ContactList extends Parse.Object<ContactListAttributes> {
  static objectClass = "contact_lists";

  constructor(attributes: ContactListAttributes) {
    super(ContactList.objectClass, attributes);
  }
}

interface MemberTagAttributes extends ArchiveAttributes {
  clubObject: Club;
  name: string;
  admin_only?: boolean;
}

@register
export class MemberTag extends Parse.Object<MemberTagAttributes> {
  static objectClass = "member_tags";

  constructor(attributes: MemberTagAttributes) {
    super(MemberTag.objectClass, attributes);
  }
}

interface FormAttributes extends ArchiveAttributes {
  clubObject: Club;
  target_contact_list?: ContactList;
  // TODO: Only target_contact_list has been confirmed against live data; forms have more fields
  // (name, published state, field definitions) not yet reverse engineered.
}

@register
export class Form extends Parse.Object<FormAttributes> {
  static objectClass = "forms";

  constructor(attributes: FormAttributes) {
    super(Form.objectClass, attributes);
  }
}

interface EmailTemplateAttributes extends ArchiveAttributes {
  clubObject: Club;
  name?: string;
  // TODO: subject/body fields not yet reverse engineered.
}

@register
export class EmailTemplate extends Parse.Object<EmailTemplateAttributes> {
  static objectClass = "email_templates";

  constructor(attributes: EmailTemplateAttributes) {
    super(EmailTemplate.objectClass, attributes);
  }
}

/**
 * A single bulk send. Only reachable via the `retrieve_sent_campaigns` / `retrieve_message_stats`
 * cloud functions (see functions.ts) - not queried directly via REST by the dashboard - but is
 * registered here so it can still be `.include()`d as a pointer target (e.g. from
 * SesEmailSuppression.last_campaign).
 */
@register
export class SesCampaign extends Parse.Object {
  static objectClass = "ses_campaigns";

  constructor() {
    super(SesCampaign.objectClass);
  }
}

interface SesEmailAttributes extends ArchiveAttributes {
  clubObject: Club;
  campaignObject?: SesCampaign;
  messageId?: string;
  sentTo?: string;
  status?: string; // e.g. "bounce"
}

@register
export class SesEmail extends Parse.Object<SesEmailAttributes> {
  static objectClass = "ses_emails";

  constructor(attributes: SesEmailAttributes) {
    super(SesEmail.objectClass, attributes);
  }
}

interface SesEmailEventAttributes extends ArchiveAttributes {
  clubObject: Club;
  emailObject?: SesEmail;
  eventType: string; // e.g. "send", "bounce", "open"
  event_timestamp?: Date;
  notificationId?: string;
  data?: Record<string, unknown>;
}

@register
export class SesEmailEvent extends Parse.Object<SesEmailEventAttributes> {
  static objectClass = "ses_email_events";

  constructor(attributes: SesEmailEventAttributes) {
    super(SesEmailEvent.objectClass, attributes);
  }
}

interface SesEmailSuppressionAttributes extends ArchiveAttributes {
  clubObject: Club;
  email: string;
  firstName?: string;
  lastName?: string;
  reason: "unsubscribe" | "bounce" | "complaint" | string;
  reason_detail?: string;
  detail?: string;
  permanent?: boolean;
  suppresed_at?: Date; // sic - typo in Clubspot's own field name
  last_campaign?: SesCampaign;
  emailObject?: SesEmail;
}

/**
 * The email bounce/unsubscribe suppression list. Check this before syncing anyone into another
 * mailing system (Google Groups, Listmonk, etc.) so suppressed addresses aren't re-added.
 */
@register
export class SesEmailSuppression extends Parse.Object<SesEmailSuppressionAttributes> {
  static objectClass = "ses_email_suppression";

  constructor(attributes: SesEmailSuppressionAttributes) {
    super(SesEmailSuppression.objectClass, attributes);
  }
}

//
// E-signatures: waiver templates and the individual signing records (contracts).
//

interface WaiverAttributes extends ArchiveAttributes {
  clubObject: Club;
  name: string;
  hidden?: boolean;
  URL?: string;
  template_id?: string;
  createdBy?: Parse.User;
  // Mixed pointers to the camps/events/regattas this waiver template applies to.
  events?: Parse.Object[];
}

@register
export class Waiver extends Parse.Object<WaiverAttributes> {
  static objectClass = "waivers";

  constructor(attributes: WaiverAttributes) {
    super(Waiver.objectClass, attributes);
  }
}

interface ContractSignerEvent {
  event: string; // e.g. "contract_sent", "contract_viewed", "sign_contract"
  timestamp: string;
  remote_ip?: string;
}

interface ContractSigner {
  id: string;
  name: string;
  email: string;
  signing_order?: string;
  auto_sign?: string;
  sign_page_url?: string;
  embedded_url?: string;
  events?: ContractSignerEvent[];
}

interface ContractAttributes extends ArchiveAttributes {
  clubObject: Club;
  contract_id: string;
  template_id: string;
  template_name?: string;
  status: "fully_signed" | "signatures_required" | string;

  waiverObject?: Waiver;
  campObject?: Camp;
  regattaObject?: Regatta;
  registrationObject?: Registration;
  // membershipObject / applicationObject --> not yet modeled

  signers?: ContractSigner[];
  signedByArray?: ContractSigner[];
}

/**
 * An individual e-signature request/record (esignatures.com-backed), e.g. a signed waiver.
 * See the E-signatures -> Contracts page of the dashboard.
 */
@register
export class Contract extends Parse.Object<ContractAttributes> {
  static objectClass = "contracts";

  constructor(attributes: ContractAttributes) {
    super(Contract.objectClass, attributes);
  }
}

//
// Accounting / Reporting.
//

interface MerchAttributes extends ArchiveAttributes {
  clubObject: Club;
  name: string;
  type?: string; // e.g. "processing_passed_on"
  price?: number;
  currency?: string;
  hidden?: boolean;
  bookable?: boolean;
  nonTaxable?: boolean;
  unlimited_stock?: boolean;
  quantity_ordered?: number;
  stock_available_now?: number;
  chartOfAccounts?: ChartOfAccounts;
  stripeAccount?: StripeAccount;
  stripe_product_id?: string;
}

/** A sellable product/fee line (merchandise, processing fees, etc.), referenced from LineItem. */
@register
export class Merch extends Parse.Object<MerchAttributes> {
  static objectClass = "merch";

  constructor(attributes: MerchAttributes) {
    super(Merch.objectClass, attributes);
  }
}

interface OrderAttributes extends ClubspotAttributes {
  status?: string; // e.g. "ordered"
  channel?: string; // e.g. "registration", "pos"
  primary?: boolean;
  comped?: boolean;

  firstName?: string;
  lastName?: string;
  description?: string;
  receipt_email?: string;

  amount: number;
  amount_due?: number;
  currency?: string;
  tax?: number;
  total?: number;
  discount?: number;
  tip?: number;
  memberDiscount?: number;
  manual_discount?: number;
  order_level_discount?: number;
  sanctioning?: number;
  surcharge?: number;
  processing_passed_on?: number;
  processingFee?: number;
  application_fee_amount?: number;

  amount_capturable?: number;
  amount_received?: number;
  amount_reversed?: number;
  amountRefunded?: number;
  amount_refunded_offline?: number;
  accounting_status?: string; // e.g. "paid"

  selected_payment_method?: string; // e.g. "card"
  payment_method_type?: string;
  checkout_url?: string;
  confirmed_at?: Date;
  available_on?: Date;
  handled_waivers?: boolean;
  required_waivers?: Waiver[];

  lineItemsArray?: LineItem[];
  registrationObject?: Registration;
  cartObject?: Cart;
  campObject?: Camp;
  customer?: Customer;
  paymentIntentObject?: PaymentIntent;
  stripeAccount?: StripeAccount;
  superAdmin?: Parse.User;
}

/** A checkout/order (one or more LineItems), the parent of the billing flow. See Reporting -> Orders. */
@register
export class Order extends Parse.Object<OrderAttributes> {
  static objectClass = "orders";

  constructor(attributes: OrderAttributes) {
    super(Order.objectClass, attributes);
  }
}

interface LineItemAttributes extends ArchiveAttributes {
  clubObject: Club;
  type?: string;
  description?: string;
  quantity?: number;
  unit_amount?: number;
  amount: number;
  confirmed_at?: Date;

  merchObject?: Merch;
  campClassObject?: CampClass;
  orderObject?: Order;
  chargeObject?: Charge;
  // posLocation, merchOption, membershipObject: not yet modeled as their own classes.
}

/**
 * A single revenue/fee line, more granular than Transaction - ties a charge to the specific
 * registration/participant/product it came from. See Reporting -> Line items.
 */
@register
export class LineItem extends Parse.Object<LineItemAttributes> {
  static objectClass = "lineItems";

  constructor(attributes: LineItemAttributes) {
    super(LineItem.objectClass, attributes);
  }
}

interface JournalLine {
  credit_acct?: string;
  debit_acct?: string;
  class_id?: string | null;
  department_id?: string | null;
  amount: number;
  line_item_id?: string;
}

interface JournalEntryLine {
  credit: number;
  debit: number;
  name: string;
  account: string;
  description?: string;
  class?: string;
  department?: string;
  number?: string;
  account_type?: string;
  specialType?: string;
  account_id?: string;
  date?: string;
  transaction_id?: string;
}

interface AccountingClassAttributes extends ArchiveAttributes {
  clubObject: Club;
  name: string;
}

/** A QuickBooks Online "Class" mapping, for sub-categorizing transactions beyond the chart of accounts. */
@register
export class AccountingClass extends Parse.Object<AccountingClassAttributes> {
  static objectClass = "accounting_classes";

  constructor(attributes: AccountingClassAttributes) {
    super(AccountingClass.objectClass, attributes);
  }
}

interface TransactionAttributes extends ArchiveAttributes {
  clubObject: Club;
  type: string; // e.g. "order_paid_immediately", "processing_fees_applied", "refund_issued", "invoice_finalized", "stripe_payout", "manually_added_expense"
  description?: string;
  event_timestamp?: Date;
  idempotency_key?: string;

  lines?: JournalLine[];
  journalsArray?: JournalEntryLine[];
  chartsArray?: ChartOfAccounts[];
  accounting_classes?: AccountingClass[];

  orderObject?: Order;
  chargeObject?: Charge;

  createdBy?: Parse.User;
}

/**
 * A general-ledger journal entry - the "Journal entries" page in the dashboard
 * (`/accounting/accounting-transactions`). This is the ground-truth double-entry ledger that gets
 * synced to QuickBooks Online (see QboSyncEvent); manually-added expenses show up here too, with
 * `type: "manually_added_expense"`.
 */
@register
export class Transaction extends Parse.Object<TransactionAttributes> {
  static objectClass = "transactions";

  constructor(attributes: TransactionAttributes) {
    super(Transaction.objectClass, attributes);
  }
}

interface QboSyncEventAttributes extends ArchiveAttributes {
  clubObject: Club;
  status: "succeeded" | "failed" | string;
  start_date: Date;
  end_date: Date;
  dateString?: string;
  number_of_journal_entries?: number;
  number_of_transactions?: number;
  succeeded_at?: Date;
  hidden?: boolean;
  createdBy?: Parse.User;
}

/**
 * One day's QuickBooks Online sync run. CSC syncs nightly; check `status` and
 * `number_of_journal_entries` here to verify the sync actually ran and moved data.
 * See Reporting -> Accounting sync.
 */
@register
export class QboSyncEvent extends Parse.Object<QboSyncEventAttributes> {
  static objectClass = "qbo_sync_events";

  constructor(attributes: QboSyncEventAttributes) {
    super(QboSyncEvent.objectClass, attributes);
  }
}

interface PayoutAttributes extends ArchiveAttributes {
  clubObject: Club;
  payoutID: string;
  amount: number;
  currency?: string;
  status?: string; // e.g. "paid"
  automatic?: boolean;
  description?: string;
  arrivalDate: Date;
  paid_out_at?: Date;
  destination_type?: string; // e.g. "bank_account"
  bank_name?: string;
  last4?: string;
  linked_ids?: string[]; // Stripe ids (charges, refunds, payouts) included in this payout.
  stripeAccount?: StripeAccount;
}

/** A Stripe payout to the club's bank account. See Reporting -> Payouts. */
@register
export class Payout extends Parse.Object<PayoutAttributes> {
  static objectClass = "payouts";

  constructor(attributes: PayoutAttributes) {
    super(Payout.objectClass, attributes);
  }
}

interface VendorAttributes extends ArchiveAttributes {
  clubObject: Club;
  name: string;
  defaultAccount?: ChartOfAccounts;
}

/** A vendor for manually-entered (non-registration) expenses. */
@register
export class Vendor extends Parse.Object<VendorAttributes> {
  static objectClass = "vendors";

  constructor(attributes: VendorAttributes) {
    super(Vendor.objectClass, attributes);
  }
}

interface InvoiceMembershipAttributes extends ArchiveAttributes {
  clubObject: Club;
  // TODO: No live data was available to confirm invoice-specific fields (amount, status, due
  // date); only these include paths were confirmed against the dashboard's own query.
  chargesArray?: Charge[];
  paymentIntentObject?: PaymentIntent;
}

/** A membership-dues invoice, separate from camp/event registration billing. */
@register
export class InvoiceMembership extends Parse.Object<InvoiceMembershipAttributes> {
  static objectClass = "invoices_membership";

  constructor(attributes: InvoiceMembershipAttributes) {
    super(InvoiceMembership.objectClass, attributes);
  }
}
