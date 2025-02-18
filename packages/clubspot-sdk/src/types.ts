import { BaseAttributes } from 'parse';
import { register, Parse } from './parse.js';

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
  static objectClass = 'clubs';

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
  static objectClass = 'user_club';

  constructor(attributes: UserClubAttributes) {
    super(UserClub.objectClass, attributes);
  }
}

interface BillingRegistrationAttributes {
  chargeAmount: number;
  cartObject?: Cart;
  registrationObject?: Registration;
}

@register
export class BillingRegistration extends Parse.Object<BillingRegistrationAttributes> {
  static objectClass = 'billing_registration';

  constructor(attributes: BillingRegistrationAttributes) {
    super(BillingRegistration.objectClass, attributes);
  }
}

interface CampAttributes extends ClubspotAttributes {
  name: string;
  startDate?: Date;
  endDate?: Date;

  imageURL?: string;

  public?: boolean;
  pending?: boolean;
  registration_closed?: boolean;

  waitlist_accepted_logic?: boolean;
  waitlist_updates?: string;
  deposit_rule?: string;
  deposits?: boolean;
  show_participants_on_signup?: boolean;
}

@register
export class Camp extends Parse.Object<CampAttributes> {
  static objectClass = 'camps';

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
  // entryFeesArray[] --> entryFees
  // productObject --> merch
  // required_waivers --> waivers
  // subclassesArray --> ??
}

@register
export class CampClass extends Parse.Object<CampClassAttributes> {
  static objectClass = 'campClasses';

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
  static objectClass = 'campSessions';

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
  static objectClass = 'carts';

  constructor(attributes: CartAttributes) {
    super(Cart.objectClass, attributes);
  }
}

interface EntryCapAttributes {
  cap: number;
  campClassObject: CampClass;
  campSessionObject?: CampSession;
}

@register
export class EntryCap extends Parse.Object<EntryCapAttributes> {
  static objectClass = 'entryCaps';

  constructor(attributes: EntryCapAttributes) {
    super(EntryCap.objectClass, attributes);
  }
}

interface CustomFieldResponse {
  customFieldID: string;
  response: string;
}

interface ParticipantAttributes {
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
  parentGuardianMobile_seconary?: string;

  member_tbd?: boolean;

  // contacts[]
  // members[]
  // members_external[]
  // profileObject
}

@register
export class Participant extends Parse.Object<ParticipantAttributes> {
  static objectClass = 'participants';

  constructor(attributes: ParticipantAttributes) {
    super(Participant.objectClass, attributes);
  }
}

interface RegistrationAttributes extends ClubspotAttributes {
  application?: boolean;
  campObject: Camp;
  confirmed_at?: Date;

  firstName?: string;
  lastName?: string;

  // Clubspot used to support multiple participants in one registration, but now only support a single participant
  // per registration. So, for most events, there will be a single element in these arrays.
  participantNames?: string[];
  participantsArray?: Participant[];

  status?: string;
  type?: string; // camp | ?
  waiver_status?: 'fully_signed' | 'signatures_required';

  //billing_registration?: BillingRegistration;
  classes?: CampClass[];
  sessions?: CampSession[];

  // Pointers
  // billing_registration --> billing_registration
  // profilesArray --> profiles
  // sessionJoinObjects[] -> registration_campSession
  // members[] --> ???
  // subclassesArray[] --->
  // superAdmin --> User
  // userObjects[]--> User
}

@register
export class Registration extends Parse.Object<RegistrationAttributes> {
  static objectClass = 'registrations';

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

interface RegistrationCampSessionAttributes
  extends BaseAttributes,
    ArchiveAttributes {
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
  static objectClass = 'registration_campSession';

  constructor(attributes: RegistrationCampSessionAttributes) {
    super(RegistrationCampSession.objectClass, attributes);
  }
}

// Shifts are used for golf schedules
@register
export class Shift extends Parse.Object {
  static objectClass = 'shifts';

  constructor() {
    super(Shift.objectClass);
  }
}

// Golf courses for the club
@register
export class Courses extends Parse.Object {
  static objectClass = 'courses';

  constructor() {
    super(Courses.objectClass);
  }
}
