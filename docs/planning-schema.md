---
tags: [architecture, planning, directus]
---

## Planning: schema

Entity-relationship diagrams for the program planning and financial model app. It is proposed and not built yet, so no `schema.yaml` declares these collections. Update the diagrams in the same change as any change to the planning design or to its collections.

### Terms

- **Program:** a lasting catalog entry, such as J-Pod Race Team. It moves from `crm` to a new `core` domain.
- **Offering:** something CYC sells for a period, such as Spring 2027 J-Pod. Charters, storage leases, merchandise and regatta hosting are offerings too.
- **Activity:** one dated, timed occurrence that consumes resources, such as a practice or a regatta day.
- **Group:** activities from different offerings that share coaches and boats, set up by the planner.
- **Cost object:** whatever a money line belongs to. That is an offering, a pool (G&A, program admin), or the org.
- **Component:** a separately versioned part of the plan. Each program has a program plan, and one operations plan holds what programs share.
- **Version:** a draft or an immutable saved snapshot of one component.
- **Plan set:** one version per component. The active set is "the plan". A scenario swaps versions, and a baseline is a frozen set that variance is measured against.

### Diagram conventions

Every version-scoped entity also has `id` (deterministic), `version_id` and `key`, which are left out of the diagrams below except where they matter. Arrays are shown as `json`. Dashed lines are references by stable `key` across components, which the engine resolves within a plan set rather than as database foreign keys.

### `core` catalog

```mermaid
erDiagram
    program_categories ||--o{ programs : groups
    programs ||--o{ offering_external_refs : "via offering key"
    qualifications ||--o{ qualification_covers : covers
    qualifications ||--o{ qualification_covers : "covered by"

    program_categories {
        uuid id PK
        string name
    }
    programs {
        uuid id PK
        string name
        uuid category_id FK
        string revenue_account
    }
    accounts {
        uuid id PK
        string number
        string name
        string type "revenue|expense|asset|liability|net_assets"
        string form_990_part
        string form_990_line
        string default_function "program|management|fundraising"
        boolean retired
    }
    qualifications {
        uuid id PK
        string name
    }
    qualification_covers {
        uuid qualification_id FK
        uuid covers_id FK
    }
    boat_classes {
        uuid id PK
        string name
        int sailors_per_boat
    }
    resource_kinds {
        uuid id PK
        string name
    }
    offering_external_refs {
        uuid offering_key
        string clubspot_camp_id
        string clubspot_class_id
    }
```

### Versioning

```mermaid
erDiagram
    programs ||--o| plan_components : "has plan"
    plan_components ||--o{ plan_versions : versions
    plan_versions |o--o{ plan_versions : parent
    plan_sets |o--o{ plan_sets : "base set"
    plan_sets ||--o{ plan_set_members : pins
    plan_components ||--o{ plan_set_members : "pinned in"
    plan_versions |o--o{ plan_set_members : "pinned version"
    plan_components ||--o{ plan_activations : "activation log"
    plan_versions ||--o{ plan_activations : activated

    plan_components {
        uuid id PK
        string kind "program|operations"
        uuid program_id FK "null for operations and product lines"
        string name
        boolean archived
    }
    plan_versions {
        uuid id PK
        uuid component_id FK
        uuid parent_version_id FK
        string status "draft|saved"
        string message
        uuid saved_by
        timestamp saved_at
    }
    plan_sets {
        uuid id PK
        string name
        string kind "active|scenario|baseline"
        uuid base_set_id FK
        date actuals_through
        timestamp frozen_at
        uuid frozen_by
    }
    plan_set_members {
        uuid plan_set_id FK
        uuid component_id FK
        uuid version_id FK "null drops the component"
    }
    plan_activations {
        uuid component_id FK
        uuid version_id FK
        timestamp activated_at
        uuid activated_by
    }
```

### Program plan (one version)

```mermaid
erDiagram
    plan_versions ||--o{ plan_offerings : contains
    programs |o--o{ plan_offerings : "offering of"
    boat_classes |o--o{ plan_offerings : sails
    qualifications |o--o{ plan_offerings : requires
    accounts ||--o{ plan_offerings : "revenue account"
    plan_offerings ||--o{ plan_offering_prices : "price tiers"
    plan_offerings ||--o{ plan_schedule_rules : "scheduled by"
    plan_offerings ||--o{ plan_activities : runs
    plan_schedule_rules |o--o{ plan_activities : generates
    plan_activities ||--o{ plan_activity_resources : uses
    plan_offerings ||--o{ plan_budget_lines : "direct lines"
    accounts ||--o{ plan_budget_lines : "booked to"

    plan_offerings {
        uuid key "stable"
        uuid program_id FK
        string product_type
        string name
        string season_term
        date starts_on
        date ends_on
        int capacity
        int target_enrollment
        int price_cents
        string price_basis
        int units
        uuid revenue_account FK
        json registration_curve
        decimal sailors_per_coach
        int min_coaches
        uuid coach_level_key "operations key"
        uuid required_qualification FK
        decimal ribs_per_coach
        uuid boat_class FK
        decimal byob_share
        decimal cogs_rate
    }
    plan_offering_prices {
        uuid offering_id FK
        string tier
        int price_cents
        decimal share
    }
    plan_schedule_rules {
        uuid offering_id FK
        json weekdays
        time start_time
        time end_time
        decimal on_water_fraction
        date starts_on
        date ends_on
        json skip_dates
        string kind "practice|regatta|clinic|camp_week"
    }
    plan_activities {
        uuid offering_id FK
        uuid schedule_rule_id FK
        date date
        time start_time
        time end_time
        int on_water_minutes
        int setup_minutes
        string kind
        boolean overridden
    }
    plan_activity_resources {
        uuid activity_id FK
        uuid resource_key "operations key"
        decimal quantity
        decimal hours
    }
    plan_budget_lines {
        string name
        uuid account_id FK
        string function
        string cost_object_type "offering|pool|org"
        uuid cost_object_key
        int amount_cents
        string formula
        int fiscal_year
        json phasing
        boolean is_participant_support
        boolean is_capital
        boolean excluded_from_base
    }
```

### Operations plan (one version)

```mermaid
erDiagram
    plan_versions ||--o{ plan_assumptions : contains
    plan_versions ||--o{ plan_staff_levels : contains
    plan_versions ||--o{ plan_salaried_positions : contains
    plan_versions ||--o{ plan_resources : contains
    plan_versions ||--o{ plan_group_rules : contains
    plan_versions ||--o{ plan_pools : contains
    plan_versions ||--o{ plan_formulas : contains
    resource_kinds ||--o{ plan_resources : "kind of"
    boat_classes ||--o{ plan_boat_rates : "rate for"
    plan_salaried_positions ||--o{ plan_salaried_bookings : "management hours"
    programs ||--o{ plan_salaried_bookings : "booked to"
    plan_staff_levels |o--o{ plan_group_rules : "hourly level"
    plan_pools ||--o{ plan_pool_shares : shares
    plan_formulas ||--o{ plan_formula_deps : "depends on"
    accounts ||--o{ plan_formulas : "booked to"
    plan_group_rules }o..o{ plan_offerings : "offering keys"
    plan_pool_shares }o..|| plan_offerings : "offering key"

    plan_assumptions {
        string name
        decimal value
        string unit
        date effective_from
    }
    plan_staff_levels {
        string name
        string pay_type "hourly|volunteer"
        int hourly_rate_cents
        json qualifications
        date effective_from
    }
    plan_salaried_positions {
        string name
        int annual_salary_cents
        int paid_hours_per_year
        json qualifications
        decimal ga_share
        uuid remainder_pool_id FK
        date effective_from
    }
    plan_salaried_bookings {
        uuid position_id FK
        uuid program_id FK
        int fiscal_year
        string kind "management"
        decimal hours
    }
    plan_resources {
        uuid resource_kind_id FK
        string name
        int quantity
        int cost_per_hour_cents
        int fuel_per_hour_cents
        int maintenance_per_hour_cents
        date effective_from
    }
    plan_boat_rates {
        uuid boat_class_id FK
        int maintenance_per_boat_hour_cents
        date effective_from
    }
    plan_group_rules {
        string name
        json offering_keys
        json weekdays
        date starts_on
        date ends_on
        uuid coach_level_id FK
        json salaried_positions
    }
    plan_pools {
        string name
        int step_order
        string method "base_share|fixed_shares|area|formula"
        string base
        json base_categories
        json targets_filter
    }
    plan_pool_shares {
        uuid pool_id FK
        uuid offering_key
        decimal share
        decimal quantity
    }
    plan_formulas {
        string name
        string dimension "none|offering|program|month"
        string expression
        uuid account_id FK
        string function
        string cost_object_type
        json applies_to_filter
        boolean excluded_from_base
    }
    plan_formula_deps {
        uuid formula_id FK
        string depends_on "formula, assumption or metric name"
    }
```

The operations plan also holds `plan_budget_lines` for org and pool lines (insurance, the clubhouse fee, fundraising, capital), with the same shape as the program plan's.

### Results and actuals

```mermaid
erDiagram
    plan_sets ||--o{ plan_results : "cached for baselines"
    plan_sets ||--o{ plan_metrics : "cached for baselines"
    accounts ||--o{ plan_results : "booked to"
    accounts ||--o{ actuals : "booked to"
    plan_results }o..o{ actuals : "same shape: cost object, account, month"

    plan_results {
        string plan_set_key "hash of pinned versions"
        uuid cost_object_key
        uuid account_id FK
        string function
        date month
        int amount_cents
        string line_key
        string explanation
    }
    plan_metrics {
        string plan_set_key
        uuid cost_object_key
        string metric "coach_hours|rib_hours|enrollment|mtdc"
        date month
        decimal value
    }
    actuals {
        uuid cost_object_key
        uuid account_id FK
        string function
        date month
        int amount_cents
        string source "qbo|clubspot"
    }
```
