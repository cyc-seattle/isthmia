import { register, Parse } from './parse.js';

interface ClubspotAttributes {
  clubObject: Club;
  archived?: boolean;
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
  imageURL?: string;

  public?: boolean;
  pending?: boolean;
  registration_closed?: boolean;
  waitlist_accepted_logic?: boolean;
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
  // entryCapsArray[] --> entryCaps
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

interface RegistrationAttributes extends ClubspotAttributes {
  application?: boolean;
  campObject: Camp;
  confirmed_at?: Date;

  firstName?: string;
  lastName?: string;
  participantNames?: string[];
  status?: string;
  type?: string; // camp | ?
  waiver_status?: 'fully_signed' | 'signatures_required';

  //billing_registration?: BillingRegistration;
  classes?: CampClass[];
  sessions?: CampSession[];

  // Pointers
  // billing_registration --> billing_registration
  // participantsArray --> participants
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
