/** Row shapes for the `people`, `contacts`, and `medical_profiles` collections. See `schema.yaml`. */
export interface PersonRow {
  id?: string;
  first_name: string;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  date_of_birth: string | null;
  gender: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
}

export type ContactRelationshipType = "guardian" | "emergency_contact";

export interface ContactRow {
  id?: string;
  related_person_id: string;
  person_id: string;
  relationship_type: ContactRelationshipType;
  contact_order: number;
  relationship_detail: string | null;
}

export interface MedicalProfileRow {
  id?: string;
  person_id: string;
  allergies: string | null;
  medications: string | null;
  conditions: string | null;
  physician_name: string | null;
  physician_phone: string | null;
  last_tetanus: string | null;
  weight: number | null;
}
