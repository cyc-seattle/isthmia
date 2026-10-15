Feature: The Community role's rules (#166)
  Families sign in to the portal's roster on the Community role. Directus enforces its relational
  rules only with a license, and dev's Directus is licensed, so the rules run here against the role
  that `crm` deploys (#172).

  Each run creates its own programs P and Q, a camp running today, an ended camp, and the people
  below. Their emails carry the run's ID. Each login signs in on the Community role:

  - "a" is guardian A. A1 (10) shares A's email, is in P and Q, and opted in for P but not Q.
  - "b" is guardian B, stored as B@ and signed in as b@. B1 (11) is in P, unanswered, and also has
  a minor recorded as a guardian.
  - "c" is C (30), in P, opted in. "d" is D, with no date of birth, in P, opted in.
  - "e" is guardian E. E1 (9) is in Q, opted in.
  - "i" is guardian I. I1 (12) is in P, but only in the ended camp.
  - "f" is guardian F. F1 (10) shares F's email, and is in P, unanswered.
  - "t" is T1 (15), in P, unanswered, with no guardian.
  - "k" coordinates P. "m" holds another role on P. "n" coordinated P until three days ago.
  - "x" matches nobody.

  Background:
    Given this run's Community fixtures on dev's Directus

  Scenario: A guardian reads their child's teammates by name
    When "a" reads people
    Then they see "A1, B1, C, D"
    And they don't see "E1, I1"

  Scenario: A guardian reads contacts only for teammates who opted in
    When "a" reads people
    Then they see the email of "guardianA, C"
    And they see no email or phone for "A1, guardianB, B1, D"

  Scenario: A login in another case reaches the same account and the same rows
    When "b" reads people
    Then they see "A1, B1, C, D"
    And they see the email of "guardianA, C"

  Scenario: A teammate from another program appears by name only, and an ended camp shows nobody
    When "e" reads people
    Then they see exactly "E1, guardianE, A1"
    And they see no email or phone for "A1"
    And they don't see "guardianA"
    When "i" reads people
    Then they see nobody

  Scenario: A login that matches nobody sees nobody
    When "x" reads people
    Then they see nobody

  Scenario: Opting out hides a guardian's contact on the next read
    Given "a" has opted out of sharing on the "A1" registration
    When "b" reads people
    Then they get no email for "guardianA"
    And "a" can opt back in on the "A1" registration

  Scenario: A family writes only its own share_contact
    Then "a" can't set share_contact on the "B1" registration
    And "a" can't move the "A1" registration to the ended camp
    And "d" can't set share_contact on the "D" registration
    And "c" can opt out and back in on the "C" registration

  Scenario: Another family's registration comes back through the names policy only
    When "a" reads the "B1" registration
    Then it has only the fields "camp_id, id, participant_id, share_contact"
    And its "camp_id, share_contact" are null
    When "a" reads the "B1" participant
    Then it has only the fields "id, person_id"

  Scenario: Nobody reads medical profiles or contact points
    Then every login gets nothing from "medical_profiles, contact_points"

  Scenario Outline: A contacts read holds the viewer's own guardian link, never another family's
    When "<login>" reads contacts
    Then they see the guardian links "<links>"

    Examples:
      | login | links          |
      | a     | A1-guardianA   |
      | b     | B1-guardianB   |
      | c     |                |
      | d     |                |
      | e     | E1-guardianE   |
      | i     | I1-guardianI   |
      | f     | F1-guardianF   |
      | t     |                |
      | x     |                |

  Scenario: The family policy's own guardian link shows three fields, and no one else's link
    When "f" reads contacts
    Then they see one link, with only the fields "contact_id, relationship_type, subject_id"
    When "f" filters contacts for the subject "B1"
    Then they see no links

  Scenario: Each login can update exactly the registrations it reads as its own
    Then every login's share_contact updates succeed on the registrations it reads with a camp, and fail on the rest

  Scenario: A Parent Coordinator sees their program's guardians' contacts without an opt-in
    When "k" reads people
    Then they see the email of "guardianB, guardianF, C"
    And they see "B1, F1, A1, T1, D" with no email or phone
    And they see no email for "minorGuardian"
    And they don't see "E1, guardianE, I1, guardianI"

  Scenario: A Parent Coordinator reads their program's guardian links, and registrations with no camp
    When "k" reads contacts
    Then they see links for the subjects "A1, B1, F1"
    When "k" reads registrations
    Then they see some, each with a null camp_id

  Scenario: Another role on the program, or an ended coordinator role, sees nothing
    Then "m, n" read nothing from "people, contacts, registrations, registration_entries, participants"

  Scenario: A filter or search can't find a person whose contact is hidden
    When "a" reads people with each query
      | query                       |
      | filter[email][_starts_with] |
      | filter[phone][_nnull]       |
      | search                      |
    Then none of them returns "B1"

  # #175: the deepest rule is the contacts policy's people read, through `contact_for`. b's only way
  # to it runs through B1's guardian link to guardian B, at the far end of that path.
  Scenario: The deepest rule resolves beyond Directus's default relational depth
    Given the deepest Community rule nests 14 relations
    And dev's Directus leaves MAX_RELATIONAL_DEPTH at its default of 10
    When "b" reads people
    Then they see the email of "guardianA"

  # #175: e sees A1 by name only. A filter on A1's hidden email or phone mustn't tell e whether it
  # matches.
  Scenario Outline: A names-only viewer can't probe a hidden column with a filter
    When "e" reads people with "<query>", for A1's real value and for one that matches nobody
    Then both return the same people, without "A1"
    And neither returns anyone "e" can't already see

    Examples:
      | query                       |
      | filter[email][_eq]          |
      | filter[email][_starts_with] |
      | filter[email][_contains]    |
      | filter[phone][_eq]          |
      | filter[phone][_starts_with] |
      | search                      |

  Scenario Outline: A names-only viewer can't probe whether a hidden column is set
    When "e" reads people with "<query>"
    Then it doesn't return "A1"

    Examples:
      | query                         |
      | filter[email][_nnull]=true    |
      | filter[phone][_nnull]=true    |
      | filter[phone][_empty]=false   |

  Scenario: Directus reports Community's registrations read as partial
    When "a" reads their permissions
    Then the registrations read is "partial"

  # The roster page's own requests, copied by hand from packages/portal/src/roster/browser.ts, since
  # the portal doesn't depend on this package. Each once answered 400 (#166 step 3).
  Scenario Outline: The portal's roster requests succeed for a Community viewer
    When "a" sends the roster's "<request>" request
    Then it succeeds

    Examples:
      | request                 |
      | entriesUrl              |
      | peopleUrl               |
      | guardianContactLinksUrl |
      | registrationsUrl        |
      | participantsUrl         |
