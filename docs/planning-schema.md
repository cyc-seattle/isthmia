---
tags: [architecture, planning, directus]
---

## Planning: schema

Entity-relationship diagrams for the program planning and financial model app. The app is proposed and not built yet, so no `schema.yaml` declares these collections. Update the diagrams in the same change as any change to the planning design or to its collections.

### Terms

- **Product:** a lasting thing CYC sells, such as J-Pod Race Team, boat charters or storage leasing. Products live in the new `core` domain.
- **Program:** a product of kind `program`, such as J-Pod Race Team. Each application groups programs its own way: the website by category, finance by revenue account, Google Workspace by Group. So no single program hierarchy exists.
- **Offering:** a product sold for a period, such as J-Pod Spring 2027, or charters for summer 2027.
- **Activity:** one dated, timed event that consumes resources, such as a practice or a regatta day.
- **Activity block:** activities from different offerings that share coaches and boats, set up by the planner. For example, J-Pod and K-Pod on Wednesdays.
- **Cost center:** what a money line belongs to. That is an offering, a pool (G&A, program admin), or the org. Offerings that earn revenue are strictly profit centers, but one field covers all three kinds.
- **Plan:** a separately versioned part of the plan. A **Program Plan** (or a Charter Plan, a Storage Plan and so on) holds one product's offerings. The **Operations Plan** holds what products share.
- **Version:** either a draft or an immutable saved snapshot of one plan.
- **Version set:** one version per plan.
  - The **active version set** is "the plan".
  - A **scenario** is a version set with some versions swapped, added or dropped.
  - A **baseline** is a frozen version set that variance is measured against.

### Diagram conventions

Every version-scoped entity also has an `id` (deterministic), a `version_id` and a `key`. The diagrams below leave these out except where they matter.

Arrays are shown as `json`.

Dashed lines are references by stable `key` across plans. The engine resolves them within a version set; they are not database foreign keys.

### `core` catalog

```mermaid
erDiagram
    products ||--o{ offering_external_refs : "via offering key"
    accounts |o--o{ products : "revenue account"
    qualifications ||--o{ qualification_covers : covers
    qualifications ||--o{ qualification_covers : "covered by"

    products {
        uuid id PK
        string name
        string kind "program|charter|storage_lease|merchandise|event_hosting|other"
        uuid revenue_account_id FK
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
    products ||--o| plans : "has plan"
    plans ||--o{ plan_versions : versions
    plan_versions |o--o{ plan_versions : parent
    version_sets |o--o{ version_sets : "base set"
    version_sets ||--o{ version_set_members : pins
    plans ||--o{ version_set_members : "pinned in"
    plan_versions |o--o{ version_set_members : "pinned version"
    plans ||--o{ plan_activations : "activation log"
    plan_versions ||--o{ plan_activations : activated

    plans {
        uuid id PK
        string kind "product|operations"
        uuid product_id FK "null for the operations plan"
        string name
        boolean archived
    }
    plan_versions {
        uuid id PK
        uuid plan_id FK
        uuid parent_version_id FK
        string status "draft|saved"
        string message
        uuid saved_by
        timestamp saved_at
    }
    version_sets {
        uuid id PK
        string name
        string kind "active|scenario|baseline"
        uuid base_set_id FK
        date actuals_through
        timestamp frozen_at
        uuid frozen_by
    }
    version_set_members {
        uuid version_set_id FK
        uuid plan_id FK
        uuid version_id FK "null drops the plan"
    }
    plan_activations {
        uuid plan_id FK
        uuid version_id FK
        timestamp activated_at
        uuid activated_by
    }
```

### Product plan (one version)

```mermaid
erDiagram
    plan_versions ||--o{ plan_offerings : contains
    products ||--o{ plan_offerings : "offering of"
    boat_classes |o--o{ plan_offerings : sails
    qualifications |o--o{ plan_offerings : requires
    plan_offerings ||--o{ plan_offering_prices : "price tiers"
    plan_offerings ||--o{ plan_schedule_rules : "scheduled by"
    plan_offerings ||--o{ plan_activities : runs
    plan_schedule_rules |o--o{ plan_activities : generates
    plan_activities ||--o{ plan_activity_resources : uses
    plan_offerings ||--o{ plan_budget_lines : "direct lines"
    accounts ||--o{ plan_budget_lines : "booked to"

    plan_offerings {
        uuid key "stable"
        uuid product_id FK
        string name
        string season_term
        date starts_on
        date ends_on
        int capacity
        int target_enrollment
        int price_cents
        string price_basis
        int units
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
        string cost_center_type "offering|pool|org"
        uuid cost_center_key
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
    plan_versions ||--o{ plan_activity_block_rules : contains
    plan_versions ||--o{ plan_pools : contains
    plan_versions ||--o{ plan_formulas : contains
    resource_kinds ||--o{ plan_resources : "kind of"
    boat_classes ||--o{ plan_boat_rates : "rate for"
    plan_salaried_positions ||--o{ plan_salaried_bookings : "management hours"
    products ||--o{ plan_salaried_bookings : "booked to"
    plan_staff_levels |o--o{ plan_activity_block_rules : "hourly level"
    plan_pools ||--o{ plan_pool_shares : shares
    plan_formulas ||--o{ plan_formula_deps : "depends on"
    accounts ||--o{ plan_formulas : "booked to"
    plan_activity_block_rules }o..o{ plan_offerings : "offering keys"
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
        uuid product_id FK
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
    plan_activity_block_rules {
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
        string dimension "none|offering|product|month"
        string expression
        uuid account_id FK
        string function
        string cost_center_type
        json applies_to_filter
        boolean excluded_from_base
    }
    plan_formula_deps {
        uuid formula_id FK
        string depends_on "formula, assumption or metric name"
    }
```

The Operations Plan also holds `plan_budget_lines` for org and pool lines (insurance, the clubhouse fee, fundraising, capital). They have the same shape as the product plan's lines.

### Results and actuals

```mermaid
erDiagram
    version_sets ||--o{ plan_results : "cached for baselines"
    version_sets ||--o{ plan_metrics : "cached for baselines"
    accounts ||--o{ plan_results : "booked to"
    accounts ||--o{ actuals : "booked to"
    plan_results }o..o{ actuals : "same shape: cost center, account, month"

    plan_results {
        string version_set_key "hash of pinned versions"
        string cost_center_type
        uuid cost_center_key
        uuid account_id FK
        string function
        date month
        int amount_cents
        string line_key
        string explanation
    }
    plan_metrics {
        string version_set_key
        uuid cost_center_key
        string metric "coach_hours|rib_hours|enrollment|mtdc"
        date month
        decimal value
    }
    actuals {
        string cost_center_type
        uuid cost_center_key
        uuid account_id FK
        string function
        date month
        int amount_cents
        string source "qbo|clubspot"
    }
```
