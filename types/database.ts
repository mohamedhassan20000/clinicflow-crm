export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      appointment_services: {
        Row: {
          appointment_id: string
          clinic_id: string
          created_at: string
          id: string
          name: string
          price: number
          quantity: number
          service_id: string | null
        }
        Insert: {
          appointment_id: string
          clinic_id: string
          created_at?: string
          id?: string
          name: string
          price: number
          quantity?: number
          service_id?: string | null
        }
        Update: {
          appointment_id?: string
          clinic_id?: string
          created_at?: string
          id?: string
          name?: string
          price?: number
          quantity?: number
          service_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "appointment_services_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: false
            referencedRelation: "appointments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointment_services_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointment_services_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      appointments: {
        Row: {
          cancellation_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          clinic_id: string
          created_at: string
          created_by: string
          deleted_at: string | null
          department_id: string | null
          deposit_amount: number
          doctor_id: string
          duration_minutes: number
          id: string
          insurance_amount: number | null
          insurance_provider_id: string | null
          no_show_reason: string | null
          no_showed_at: string | null
          no_showed_by: string | null
          notes: string | null
          outstanding_amount: number | null
          paid_amount: number | null
          paid_at: string | null
          patient_id: string
          payment_method: Database["public"]["Enums"]["payment_method"] | null
          payment_note: string | null
          reminder_sent_at: string | null
          scheduled_at: string
          secondary_amount: number
          secondary_payment_method:
            | Database["public"]["Enums"]["payment_method"]
            | null
          service_id: string | null
          status: Database["public"]["Enums"]["appointment_status"]
          total_amount: number | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          clinic_id: string
          created_at?: string
          created_by: string
          deleted_at?: string | null
          department_id?: string | null
          deposit_amount?: number
          doctor_id: string
          duration_minutes?: number
          id?: string
          insurance_amount?: number | null
          insurance_provider_id?: string | null
          no_show_reason?: string | null
          no_showed_at?: string | null
          no_showed_by?: string | null
          notes?: string | null
          outstanding_amount?: number | null
          paid_amount?: number | null
          paid_at?: string | null
          patient_id: string
          payment_method?: Database["public"]["Enums"]["payment_method"] | null
          payment_note?: string | null
          reminder_sent_at?: string | null
          scheduled_at: string
          secondary_amount?: number
          secondary_payment_method?:
            | Database["public"]["Enums"]["payment_method"]
            | null
          service_id?: string | null
          status?: Database["public"]["Enums"]["appointment_status"]
          total_amount?: number | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          clinic_id?: string
          created_at?: string
          created_by?: string
          deleted_at?: string | null
          department_id?: string | null
          deposit_amount?: number
          doctor_id?: string
          duration_minutes?: number
          id?: string
          insurance_amount?: number | null
          insurance_provider_id?: string | null
          no_show_reason?: string | null
          no_showed_at?: string | null
          no_showed_by?: string | null
          notes?: string | null
          outstanding_amount?: number | null
          paid_amount?: number | null
          paid_at?: string | null
          patient_id?: string
          payment_method?: Database["public"]["Enums"]["payment_method"] | null
          payment_note?: string | null
          reminder_sent_at?: string | null
          scheduled_at?: string
          secondary_amount?: number
          secondary_payment_method?:
            | Database["public"]["Enums"]["payment_method"]
            | null
          service_id?: string | null
          status?: Database["public"]["Enums"]["appointment_status"]
          total_amount?: number | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "appointments_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_doctor_id_fkey"
            columns: ["doctor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_insurance_provider_id_fkey"
            columns: ["insurance_provider_id"]
            isOneToOne: false
            referencedRelation: "insurance_providers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_no_showed_by_fkey"
            columns: ["no_showed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_id: string | null
          clinic_id: string | null
          created_at: string
          id: string
          ip_address: string | null
          new_data: Json | null
          old_data: Json | null
          record_id: string | null
          table_name: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          clinic_id?: string | null
          created_at?: string
          id?: string
          ip_address?: string | null
          new_data?: Json | null
          old_data?: Json | null
          record_id?: string | null
          table_name: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          clinic_id?: string | null
          created_at?: string
          id?: string
          ip_address?: string | null
          new_data?: Json | null
          old_data?: Json | null
          record_id?: string | null
          table_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_logs_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
        ]
      }
      clinic_working_hours: {
        Row: {
          clinic_id: string
          created_at: string
          day_of_week: number
          id: string
          shift_end: string
          shift_start: string
        }
        Insert: {
          clinic_id: string
          created_at?: string
          day_of_week: number
          id?: string
          shift_end: string
          shift_start: string
        }
        Update: {
          clinic_id?: string
          created_at?: string
          day_of_week?: number
          id?: string
          shift_end?: string
          shift_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "clinic_working_hours_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
        ]
      }
      clinics: {
        Row: {
          address: string | null
          created_at: string
          id: string
          is_active: boolean
          logo_url: string | null
          name: string
          phone: string | null
          reminder_lead_hours: number
          updated_at: string
          working_hours_end: string | null
          working_hours_start: string | null
        }
        Insert: {
          address?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          logo_url?: string | null
          name: string
          phone?: string | null
          reminder_lead_hours?: number
          updated_at?: string
          working_hours_end?: string | null
          working_hours_start?: string | null
        }
        Update: {
          address?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          logo_url?: string | null
          name?: string
          phone?: string | null
          reminder_lead_hours?: number
          updated_at?: string
          working_hours_end?: string | null
          working_hours_start?: string | null
        }
        Relationships: []
      }
      departments: {
        Row: {
          clinic_id: string
          color: string
          created_at: string
          deleted_at: string | null
          description: string | null
          id: string
          is_active: boolean
          name: string
        }
        Insert: {
          clinic_id: string
          color?: string
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
        }
        Update: {
          clinic_id?: string
          color?: string
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "departments_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
        ]
      }
      doctor_schedules: {
        Row: {
          clinic_id: string
          created_at: string
          day_of_week: number
          doctor_id: string
          end_time: string
          id: string
          start_time: string
        }
        Insert: {
          clinic_id: string
          created_at?: string
          day_of_week: number
          doctor_id: string
          end_time: string
          id?: string
          start_time: string
        }
        Update: {
          clinic_id?: string
          created_at?: string
          day_of_week?: number
          doctor_id?: string
          end_time?: string
          id?: string
          start_time?: string
        }
        Relationships: [
          {
            foreignKeyName: "doctor_schedules_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "doctor_schedules_doctor_id_fkey"
            columns: ["doctor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      feedback: {
        Row: {
          appointment_id: string
          comment: string | null
          created_at: string
          id: string
          rating: number | null
          submitted_at: string | null
          token: string
          token_expires_at: string
        }
        Insert: {
          appointment_id: string
          comment?: string | null
          created_at?: string
          id?: string
          rating?: number | null
          submitted_at?: string | null
          token?: string
          token_expires_at?: string
        }
        Update: {
          appointment_id?: string
          comment?: string | null
          created_at?: string
          id?: string
          rating?: number | null
          submitted_at?: string | null
          token?: string
          token_expires_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "feedback_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: true
            referencedRelation: "appointments"
            referencedColumns: ["id"]
          },
        ]
      }
      follow_ups: {
        Row: {
          appointment_id: string | null
          clinic_id: string
          created_at: string
          id: string
          notes: string | null
          outcome: Database["public"]["Enums"]["follow_up_outcome"]
          patient_id: string
          recorded_at: string
          recorded_by: string | null
        }
        Insert: {
          appointment_id?: string | null
          clinic_id: string
          created_at?: string
          id?: string
          notes?: string | null
          outcome: Database["public"]["Enums"]["follow_up_outcome"]
          patient_id: string
          recorded_at?: string
          recorded_by?: string | null
        }
        Update: {
          appointment_id?: string | null
          clinic_id?: string
          created_at?: string
          id?: string
          notes?: string | null
          outcome?: Database["public"]["Enums"]["follow_up_outcome"]
          patient_id?: string
          recorded_at?: string
          recorded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "follow_ups_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: false
            referencedRelation: "appointments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follow_ups_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follow_ups_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follow_ups_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      insurance_providers: {
        Row: {
          clinic_id: string
          code: string | null
          created_at: string
          deleted_at: string | null
          id: string
          is_active: boolean
          name: string
          updated_at: string
        }
        Insert: {
          clinic_id: string
          code?: string | null
          created_at?: string
          deleted_at?: string | null
          id?: string
          is_active?: boolean
          name: string
          updated_at?: string
        }
        Update: {
          clinic_id?: string
          code?: string | null
          created_at?: string
          deleted_at?: string | null
          id?: string
          is_active?: boolean
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "insurance_providers_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
        ]
      }
      medical_notes: {
        Row: {
          created_at: string
          created_by: string | null
          deleted_at: string | null
          doctor_id: string
          id: string
          note: string
          patient_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          doctor_id: string
          id?: string
          note: string
          patient_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          doctor_id?: string
          id?: string
          note?: string
          patient_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "medical_notes_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medical_notes_doctor_id_fkey"
            columns: ["doctor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medical_notes_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
        ]
      }
      medical_note_attachments: {
        Row: {
          clinic_id: string
          created_at: string
          deleted_at: string | null
          file_name: string
          id: string
          mime_type: string
          note_id: string
          patient_id: string
          size_bytes: number
          storage_path: string
          updated_at: string
          uploaded_by: string | null
        }
        Insert: {
          clinic_id: string
          created_at?: string
          deleted_at?: string | null
          file_name: string
          id?: string
          mime_type: string
          note_id: string
          patient_id: string
          size_bytes: number
          storage_path: string
          updated_at?: string
          uploaded_by?: string | null
        }
        Update: {
          clinic_id?: string
          created_at?: string
          deleted_at?: string | null
          file_name?: string
          id?: string
          mime_type?: string
          note_id?: string
          patient_id?: string
          size_bytes?: number
          storage_path?: string
          updated_at?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "medical_note_attachments_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medical_note_attachments_note_id_fkey"
            columns: ["note_id"]
            isOneToOne: false
            referencedRelation: "medical_notes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medical_note_attachments_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "medical_note_attachments_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      outstanding_settlements: {
        Row: {
          amount: number
          appointment_id: string | null
          clinic_id: string
          created_at: string
          created_by: string | null
          id: string
          note: string | null
          patient_id: string
          payment_method: string
          settled_at: string
          source_appointment_id: string | null
        }
        Insert: {
          amount: number
          appointment_id?: string | null
          clinic_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          patient_id: string
          payment_method: string
          settled_at?: string
          source_appointment_id?: string | null
        }
        Update: {
          amount?: number
          appointment_id?: string | null
          clinic_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          patient_id?: string
          payment_method?: string
          settled_at?: string
          source_appointment_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "outstanding_settlements_appointment_id_fkey"
            columns: ["appointment_id"]
            isOneToOne: false
            referencedRelation: "appointments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outstanding_settlements_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outstanding_settlements_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outstanding_settlements_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
        ]
      }
      patient_deposits: {
        Row: {
          amount: number
          clinic_id: string
          created_at: string
          created_by: string | null
          id: string
          note: string | null
          patient_id: string
          payment_method: string
        }
        Insert: {
          amount: number
          clinic_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          patient_id: string
          payment_method: string
        }
        Update: {
          amount?: number
          clinic_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          note?: string | null
          patient_id?: string
          payment_method?: string
        }
        Relationships: [
          {
            foreignKeyName: "patient_deposits_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_deposits_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_deposits_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
        ]
      }
      patient_documents: {
        Row: {
          category: Database["public"]["Enums"]["patient_document_category"]
          clinic_id: string
          created_at: string
          deleted_at: string | null
          file_name: string
          id: string
          label: string | null
          mime_type: string
          patient_id: string
          size_bytes: number
          storage_path: string
          updated_at: string
          uploaded_by: string | null
        }
        Insert: {
          category: Database["public"]["Enums"]["patient_document_category"]
          clinic_id: string
          created_at?: string
          deleted_at?: string | null
          file_name: string
          id?: string
          label?: string | null
          mime_type: string
          patient_id: string
          size_bytes: number
          storage_path: string
          updated_at?: string
          uploaded_by?: string | null
        }
        Update: {
          category?: Database["public"]["Enums"]["patient_document_category"]
          clinic_id?: string
          created_at?: string
          deleted_at?: string | null
          file_name?: string
          id?: string
          label?: string | null
          mime_type?: string
          patient_id?: string
          size_bytes?: number
          storage_path?: string
          updated_at?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "patient_documents_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_documents_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_documents_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      patients: {
        Row: {
          assigned_doctor_id: string | null
          avatar_path: string | null
          blood_type: Database["public"]["Enums"]["blood_type"] | null
          clinic_id: string
          created_at: string
          created_by: string
          date_of_birth: string
          department_id: string | null
          email: string
          file_number: string
          full_name: string
          id: string
          insurance_provider_id: string | null
          is_deleted: boolean
          national_id: string
          phone: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          assigned_doctor_id?: string | null
          avatar_path?: string | null
          blood_type?: Database["public"]["Enums"]["blood_type"] | null
          clinic_id: string
          created_at?: string
          created_by: string
          date_of_birth: string
          department_id?: string | null
          email: string
          file_number: string
          full_name: string
          id?: string
          insurance_provider_id?: string | null
          is_deleted?: boolean
          national_id: string
          phone: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          assigned_doctor_id?: string | null
          avatar_path?: string | null
          blood_type?: Database["public"]["Enums"]["blood_type"] | null
          clinic_id?: string
          created_at?: string
          created_by?: string
          date_of_birth?: string
          department_id?: string | null
          email?: string
          file_number?: string
          full_name?: string
          id?: string
          insurance_provider_id?: string | null
          is_deleted?: boolean
          national_id?: string
          phone?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "patients_assigned_doctor_id_fkey"
            columns: ["assigned_doctor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patients_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patients_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patients_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patients_insurance_provider_id_fkey"
            columns: ["insurance_provider_id"]
            isOneToOne: false
            referencedRelation: "insurance_providers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patients_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          clinic_id: string
          created_at: string
          deleted_at: string | null
          department_id: string | null
          full_name: string
          id: string
          is_active: boolean
          is_deleted: boolean
          last_login_at: string | null
          must_change_password: boolean
          phone: string | null
          role: Database["public"]["Enums"]["user_role"]
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          clinic_id: string
          created_at?: string
          deleted_at?: string | null
          department_id?: string | null
          full_name: string
          id: string
          is_active?: boolean
          is_deleted?: boolean
          last_login_at?: string | null
          must_change_password?: boolean
          phone?: string | null
          role: Database["public"]["Enums"]["user_role"]
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          clinic_id?: string
          created_at?: string
          deleted_at?: string | null
          department_id?: string | null
          full_name?: string
          id?: string
          is_active?: boolean
          is_deleted?: boolean
          last_login_at?: string | null
          must_change_password?: boolean
          phone?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
        ]
      }
      services: {
        Row: {
          clinic_id: string
          created_at: string
          deleted_at: string | null
          department_id: string
          id: string
          is_active: boolean
          name: string
          price: number
          updated_at: string
        }
        Insert: {
          clinic_id: string
          created_at?: string
          deleted_at?: string | null
          department_id: string
          id?: string
          is_active?: boolean
          name: string
          price: number
          updated_at?: string
        }
        Update: {
          clinic_id?: string
          created_at?: string
          deleted_at?: string | null
          department_id?: string
          id?: string
          is_active?: boolean
          name?: string
          price?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "services_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_invitations: {
        Row: {
          accepted_at: string | null
          clinic_id: string
          created_at: string
          department_id: string | null
          email: string
          expires_at: string
          id: string
          invited_by: string
          role: Database["public"]["Enums"]["user_role"]
          token: string
        }
        Insert: {
          accepted_at?: string | null
          clinic_id: string
          created_at?: string
          department_id?: string | null
          email: string
          expires_at?: string
          id?: string
          invited_by: string
          role: Database["public"]["Enums"]["user_role"]
          token?: string
        }
        Update: {
          accepted_at?: string | null
          clinic_id?: string
          created_at?: string
          department_id?: string | null
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string
          role?: Database["public"]["Enums"]["user_role"]
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_invitations_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_invitations_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_invitations_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_customizations: {
        Row: {
          access: string
          clinic_id: string
          created_at: string
          feature: string
          id: string
          page: string
          profile_id: string
          updated_at: string
        }
        Insert: {
          access: string
          clinic_id: string
          created_at?: string
          feature: string
          id?: string
          page: string
          profile_id: string
          updated_at?: string
        }
        Update: {
          access?: string
          clinic_id?: string
          created_at?: string
          feature?: string
          id?: string
          page?: string
          profile_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_customizations_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_customizations_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_page_permissions: {
        Row: {
          clinic_id: string
          created_at: string
          is_visible: boolean
          page_slug: string
          updated_at: string
          user_id: string
        }
        Insert: {
          clinic_id: string
          created_at?: string
          is_visible?: boolean
          page_slug: string
          updated_at?: string
          user_id: string
        }
        Update: {
          clinic_id?: string
          created_at?: string
          is_visible?: boolean
          page_slug?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_page_permissions_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_page_permissions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      auth_clinic_id: { Args: never; Returns: string }
      auth_department_id: { Args: never; Returns: string }
      auth_profile: {
        Args: never
        Returns: {
          clinic_id: string
          profile_id: string
          role: Database["public"]["Enums"]["user_role"]
        }[]
      }
      auth_role: {
        Args: never
        Returns: Database["public"]["Enums"]["user_role"]
      }
      clear_own_must_change_password: { Args: never; Returns: undefined }
      complete_appointment_billing: {
        Args: {
          p_appointment_id: string
          p_deposit_amount?: number
          p_insurance_amount?: number
          p_line_items: Json
          p_paid_amount: number
          p_payment_method: string
          p_payment_note?: string
          p_secondary_amount?: number
          p_secondary_payment_method?: string
        }
        Returns: undefined
      }
      complete_appointment_billing_with_previous_settlement: {
        Args: {
          p_appointment_id: string
          p_deposit_amount?: number
          p_insurance_amount?: number
          p_line_items: Json
          p_paid_amount: number
          p_payment_method: string
          p_payment_note?: string
          p_previous_note?: string
          p_previous_payment_method?: string
          p_previous_settlement_amount?: number
          p_secondary_amount?: number
          p_secondary_payment_method?: string
        }
        Returns: {
          affected_prior_appointment_ids: string[]
          current_collected: number
          current_outstanding: number
          current_total: number
          previous_outstanding_after: number
          previous_outstanding_before: number
          previous_settled_now: number
        }[]
      }
      settle_patient_outstanding: {
        Args: {
          p_amount?: number
          p_appointment_id?: string
          p_note?: string
          p_patient_id: string
          p_payment_method?: string
          p_secondary_amount?: number
          p_secondary_payment_method?: string
        }
        Returns: undefined
      }
      restore_medical_note_attachment: {
        Args: {
          p_attachment_id: string
          p_note_id: string
          p_patient_id: string
        }
        Returns: boolean
      }
      restore_patient_document: {
        Args: { p_document_id: string; p_patient_id: string }
        Returns: boolean
      }
      soft_delete_medical_note_attachment: {
        Args: {
          p_attachment_id: string
          p_note_id: string
          p_patient_id: string
        }
        Returns: boolean
      }
      soft_delete_patient: {
        Args: { p_patient_id: string }
        Returns: boolean
      }
      soft_delete_patient_document: {
        Args: { p_document_id: string; p_patient_id: string }
        Returns: boolean
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      undo_appointment_billing: {
        Args: { p_appointment_id: string; p_target_status: string }
        Returns: undefined
      }
      undo_appointment_billing_with_previous_settlement: {
        Args: { p_appointment_id: string; p_target_status: string }
        Returns: {
          affected_prior_appointment_ids: string[]
          reversed_amount: number
        }[]
      }
    }
    Enums: {
      appointment_status:
        | "pending"
        | "confirmed"
        | "completed"
        | "cancelled"
        | "no_show"
      blood_type: "A+" | "A-" | "B+" | "B-" | "AB+" | "AB-" | "O+" | "O-"
      follow_up_outcome: "all_fine" | "has_problem" | "no_response"
      patient_document_category: "national_id" | "insurance" | "other"
      payment_method:
        | "cash"
        | "credit_card"
        | "paypal"
        | "bank_transfer"
        | "insurance"
      user_role: "admin" | "receptionist" | "manager" | "doctor"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      appointment_status: [
        "pending",
        "confirmed",
        "completed",
        "cancelled",
        "no_show",
      ],
      blood_type: ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"],
      follow_up_outcome: ["all_fine", "has_problem", "no_response"],
      patient_document_category: ["national_id", "insurance", "other"],
      payment_method: [
        "cash",
        "credit_card",
        "paypal",
        "bank_transfer",
        "insurance",
      ],
      user_role: ["admin", "receptionist", "manager", "doctor"],
    },
  },
} as const
