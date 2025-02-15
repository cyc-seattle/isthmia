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

// includes:
// "campObject.clubObject.mailchimpAccount.mailchimpCredentials,
// billing_registration.customer,
// participantsArray.tierObject,
// sessionJoinObjects.campSessionObject,
// sessionJoinObjects.campClassObject.subclassesArray,
// sessionJoinObjects.subclassObject"
@register
export class Registration extends Parse.Object {
  static objectClass = 'registrations';

  accessor application: boolean | undefined;

  accessor archived: boolean | undefined;

  // Pointers
  // billing_registration --> billing_registration
  // campObject -> camps
  // classes[] -> campClasses
  // sessions[] -> campSessions
  // clubObject -> clubs
  // participantsArray --> participants
  // sessionJoinObjects[] -> campSessions

  accessor confirmedAt: Date | undefined;

  accessor firstName: string | undefined;

  accessor lastName: string | undefined;

  accessor participantNames: string[] | undefined;

  accessor status: string | undefined;

  //@field("waiver_status")
  accessor waiverStatus: string | undefined;
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
