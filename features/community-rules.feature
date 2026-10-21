# These scenarios describe today's rules. The visibility model is being redesigned (TODO: issue).
@licensed
Feature: The Community role's rules (#166)
  Families sign in to the portal's roster on the Community role. Directus enforces its relational
  rules only with a license, and dev's Directus is licensed, so the rules run here against the role
  that `crm` deploys (#172).

  Each run builds its own season, and every email carries the run's ID. Summer Session 1 has ended,
  and Summer Session 2 is running now. The Laser Race Team sails in both. Opti Green sails in Summer
  Session 2, and Opti Red sailed in Summer Session 1. A family sees everyone sailing in their child's
  programs in a camp running now, and contact details only for those who opted in. Each grown-up
  below signs in on the Community role.

  Marge Simpson signs in for Bart (13), who shares her email. Bart sails in both of Summer Session
  2's classes. He shares contacts for the Laser Race Team but not for Opti Green. Ned Flanders signs
  in for Todd (12), who sails Laser and hasn't answered the sharing question. Ned's account is stored
  in lowercase, and he signs in typing capitals. Todd's brother Rod (16) is recorded by mistake as
  Todd's second guardian. Lenny Leonard (30) sails Laser himself and shares. Moe Szyslak sails Laser
  and shares, but has no date of birth on file. Kirk Van Houten signs in for Milhouse (12), who sails
  Opti Green and shares.

  Helen Lovejoy signs in for Jessica (13), who sailed Opti Red in Summer Session 1. Martin Prince
  (13) sailed with her and shares, so his mother Martha's contact shows. Nelson Muntz (14) sailed
  Laser in Summer Session 1 only, without answering, and has no guardian on file. Chief Clancy Wiggum signs in
  for Ralph (13), who shares his email and sails Laser without answering. Jimbo Jones (15) signs in
  himself. He sails Laser without answering and has no guardian on file.

  Edna Krabappel is the Laser Race Team's Parent Coordinator. Seymour Skinner volunteers for the team
  in another role. Groundskeeper Willie was its Parent Coordinator until three days ago. Hans Moleman
  signs in, but no one in the CRM has his email.

  Background:
    Given this run's Community fixtures on dev's Directus

  Scenario: Viewing the Laser Race Team, a guardian sees every teammate by name, whether or not they opted in
    When "Marge" reads people
    Then they see "Bart, Todd, Lenny, Moe, Ralph, Jimbo"
    And they don't see "Jessica, Martin"

  Scenario: Marge doesn't see Nelson, who sailed Laser only in the ended camp
    When "Marge" reads people
    Then they don't see "Nelson"

  Scenario: A child in two programs has two teams, so Marge sees Milhouse from Opti Green
    When "Marge" reads people
    Then they see "Milhouse"

  Scenario: A guardian reads contacts only for teammates who opted in
    When "Marge" reads people
    Then they see the email of "Marge, Lenny, Kirk"
    And they see no email or phone for "Bart, Ned, Todd, Moe, Milhouse"

  Scenario: A login in another case reaches the same account and the same rows
    When "Ned" reads people
    Then they see "Bart, Todd, Lenny, Moe"
    And they see the email of "Marge, Lenny"

  Scenario: A teammate from another program appears by name only
    When "Kirk" reads people
    Then they see exactly "Milhouse, Kirk, Bart"
    And they see no email or phone for "Bart"
    And they don't see "Marge"

  Scenario: Once a camp ends, a family sees only itself
    When "Helen" reads people
    Then they see exactly "Helen, Jessica"

  Scenario: A login that matches nobody sees nobody
    When "Hans" reads people
    Then they see nobody

  Scenario: Opting out hides a guardian's contact on the next read
    Given "Marge" has opted out of sharing on the "Bart" registration
    When "Ned" reads people
    Then they get no email for "Marge"
    And "Marge" can opt back in on the "Bart" registration

  Scenario: A family writes only its own share_contact
    Then "Marge" can't set share_contact on the "Todd" registration
    And "Marge" can't move the "Bart" registration to the ended camp
    And "Moe" can't set share_contact on the "Moe" registration
    And "Lenny" can opt out and back in on the "Lenny" registration
    And "Helen" can't set share_contact on the "Jessica" registration

  Scenario: Another family's registration comes back through the names policy only
    When "Marge" reads the "Todd" registration
    Then it has only the fields "camp_id, id, participant_id, share_contact"
    And its "camp_id, share_contact" are null
    When "Marge" reads the "Todd" participant
    Then it has only the fields "id, person_id"

  Scenario: Nobody reads medical profiles or contact points
    Then every login gets nothing from "medical_profiles, contact_points"

  Scenario Outline: A contacts read holds the viewer's own guardian link, and opted-in teammates' links
    When "<login>" reads contacts
    Then they see the guardian links "<links>"

    Examples:
      | login  | links                        |
      | Marge  | Bart-Marge, Milhouse-Kirk    |
      | Ned    | Todd-Ned, Bart-Marge         |
      | Lenny  | Bart-Marge                   |
      | Moe    | Bart-Marge                   |
      | Kirk   | Milhouse-Kirk                |
      | Helen  | Jessica-Helen                |
      | Clancy | Ralph-Clancy, Bart-Marge     |
      | Jimbo  | Bart-Marge                   |
      | Hans   |                              |

  Scenario: A guardian link shows three fields, and never a link the viewer has no reason to see
    When "Clancy" reads contacts
    Then every link has only the fields "contact_id, relationship_type, subject_id"
    When "Clancy" filters contacts for the subject "Todd"
    Then they see no links

  Scenario: Each login can update exactly the registrations it reads as its own
    Then every login's share_contact updates succeed on the registrations it reads with a camp, and fail on the rest

  Scenario: A Parent Coordinator sees their program's guardians' contacts without an opt-in
    When "Edna" reads people
    Then they see the email of "Marge, Ned, Clancy, Lenny"
    And they see "Todd, Ralph, Bart, Jimbo, Moe" with no email or phone
    And they see no email for "Rod"
    And they don't see "Milhouse, Kirk, Jessica, Helen, Martin, Martha, Nelson"

  Scenario: A Parent Coordinator reads their program's guardian links, and registrations with no camp
    When "Edna" reads contacts
    Then they see links for the subjects "Bart, Todd, Ralph"
    When "Edna" reads registrations
    Then they see some, each with a null camp_id

  Scenario: Another role on the program, or an ended coordinator role, sees nothing
    Then "Seymour, Willie" read nothing from "people, contacts, registrations, registration_entries, participants"

  Scenario: A filter or search can't find a person whose contact is hidden
    When "Marge" reads people with each query
      | query                       |
      | filter[email][_starts_with] |
      | filter[phone][_nnull]       |
      | search                      |
    Then none of them returns "Todd"

  # #175: the deepest rule is the contacts policy's people read, through `contact_for`. Ned's only
  # way to it runs through Bart's guardian link to Marge, at the far end of that path.
  Scenario: The deepest rule resolves beyond Directus's default relational depth
    Given the deepest Community rule nests 14 relations
    And dev's Directus leaves MAX_RELATIONAL_DEPTH at its default of 10
    When "Ned" reads people
    Then they see the email of "Marge"

  # #175: Kirk sees Bart by name only. A filter on Bart's hidden email or phone, or on his guardian
  # Marge's, mustn't tell Kirk whether it matches.
  Scenario Outline: A names-only viewer can't probe a hidden column with a filter
    When "Kirk" reads people with "<query>", for Bart's real value and for one that matches nobody
    Then both return the same people, without "Bart"
    And neither returns anyone "Kirk" can't already see

    Examples:
      | query                                                |
      | filter[email][_eq]                                   |
      | filter[email][_starts_with]                          |
      | filter[email][_contains]                             |
      | filter[phone][_eq]                                   |
      | filter[phone][_starts_with]                          |
      | search                                               |
      | filter[my_contacts][contact_id][email][_eq]          |
      | filter[my_contacts][contact_id][email][_starts_with] |

  Scenario Outline: A names-only viewer can't probe whether a hidden column is set
    When "Kirk" reads people with "<query>"
    Then it doesn't return "Bart"

    Examples:
      | query                       |
      | filter[email][_nnull]=true  |
      | filter[phone][_nnull]=true  |
      | filter[phone][_empty]=false |

  # Directus sorts, groups, and aggregates on the raw column, so the guard refuses them outright.
  Scenario Outline: A names-only viewer can't sort, group, or aggregate on a hidden column
    When "Kirk" reads people with "<query>"
    Then Directus refuses it

    Examples:
      | query                                                       |
      | sort=email                                                  |
      | sort=-phone                                                 |
      | groupBy[]=email&aggregate[count]=id                         |
      | aggregate[countDistinct]=phone                              |
      | deep[my_contacts][_filter][relationship_type][_eq]=guardian |

  Scenario: Directus reports Community's registrations read as partial
    When "Marge" reads their permissions
    Then the registrations read is "partial"

  # The roster page's own requests, copied by hand from packages/portal/src/roster/browser.ts, since
  # the portal doesn't depend on this package. Each once answered 400 (#166 step 3).
  Scenario Outline: The portal's roster requests succeed for a Community viewer
    When "Marge" sends the roster's "<request>" request
    Then it succeeds

    Examples:
      | request                 |
      | entriesUrl              |
      | peopleUrl               |
      | guardianContactLinksUrl |
      | registrationsUrl        |
      | participantsUrl         |
