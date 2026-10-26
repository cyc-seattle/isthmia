Feature: Signing in to the portal and Directus (#173)
  Today's flows, through a browser: the portal sends an anonymous visitor to Authentik, an emailed
  link signs them in, and Directus signs them in through Authentik. Dev's Authentik sends its mail to Mailpit, which the steps read through
  the Kubernetes API's service proxy. Each run signs in with a new email, so Authentik creates a new
  user for it.

  Scenario: The portal sends an anonymous visitor to sign in
    When I open the portal
    Then I'm on Authentik's sign-in page

  Scenario: An emailed link signs a new visitor in to the portal
    Given I have an email address Authentik hasn't seen
    When I open the portal
    And I ask Authentik to email me a sign-in link
    Then the email arrives in Mailpit, with a sign-in link
    When I follow the link
    Then the portal shows that I'm signed in

  Scenario: A visitor signed in to Authentik signs in to Directus
    Given I have an email address Authentik hasn't seen
    When I open the portal
    And I ask Authentik to email me a sign-in link
    Then the email arrives in Mailpit, with a sign-in link
    When I follow the link
    Then the portal shows that I'm signed in
    When the portal signs me in to Directus through Authentik
    Then I'm back on the portal
    And Directus has an Authentik user with my email
