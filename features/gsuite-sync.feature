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
