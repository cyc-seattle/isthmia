Feature: gsuite-sync brings program roles into Google Groups
  The scenario sets up a program and its role holders in dev's CRM, runs the gsuite-sync CronJob
  as a Job, and reads the Workspace fake's Directory API through the Kubernetes API's service proxy.
  Its group and people carry the run's ID, so runs never depend on each other.

  # One scenario, because each sync run takes minutes: the second run starts from the first's end
  # state, so the whole feature needs only two. The Workspace fake can't remove a member, so the
  # leaver leaves before the first run: the CRM records that the sync added them, and the group
  # doesn't have them.
  Scenario: Role holders join the program's group, and one who leaves stays out until staff let them back
    Given a group in the Workspace fake
    And a program in the CRM that points at the group
    And a person in the CRM who holds a role in the program
    And a second role holder whom gsuite-sync added to the group, who has since left it
    When gsuite-sync runs
    Then the person is a member of the group
    And the leaver is not a member of the group
    And the leaver's membership row records that they left
    When staff delete the leaver's membership row
    And gsuite-sync runs again
    Then the leaver is a member of the group
    And the leaver has a fresh membership row
