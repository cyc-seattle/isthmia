Feature: gsuite-sync brings program roles into Google Groups
  The scenario sets up a program and a role holder in dev's CRM, runs the gsuite-sync CronJob once
  as a Job, and reads the Workspace fake's Directory API through the Kubernetes API's service proxy.
  Its group and people carry the run's ID, so runs never depend on each other.

  Scenario: A program's role holder becomes a member of the program's group
    Given a group in the Workspace fake
    And a program in the CRM that points at the group
    And a person in the CRM who holds a role in the program
    When gsuite-sync runs
    Then the person is a member of the group

  # One scenario, because letting someone back in starts from where leaving ends: as two, the second
  # would repeat the first's sync runs. The Workspace fake can't remove a member, so the person leaves
  # before the first run: the CRM records that the sync added them, and the group doesn't have them.
  Scenario: A member who leaves isn't re-added until staff delete their membership row
    Given a group in the Workspace fake
    And a program in the CRM that points at the group
    And a person in the CRM who holds a role in the program
    And a membership row that says gsuite-sync added the person, who has since left the group
    When gsuite-sync runs
    Then the person is not a member of the group
    And the person's membership row records that they left
    When staff delete the person's membership row
    And gsuite-sync runs again
    Then the person is a member of the group
    And the person has a fresh membership row
