Feature: clubspot-sync brings Clubspot's registrations into the CRM
  The scenario seeds dev's Clubspot fake through Parse's REST API, runs the clubspot-sync CronJob
  once as a Job, and reads the result through Directus's REST API. Its camp and people carry the
  run's ID, so runs never depend on each other (#185).

  Scenario: A participant's registration becomes a person with a guardian
    Given a camp running today in the Clubspot fake
    And a participant registered in it, with a guardian
    When clubspot-sync runs
    Then the CRM has the participant as a person
    And the person's guardian is a person, linked as their guardian
