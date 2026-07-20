export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      agent_conversations: {
        Row: {
          clinic_id: string
          created_at: string
          id: string
          locale: string
          patient_id: string | null
          persona: Database["public"]["Enums"]["agent_persona"]
          status: string
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          clinic_id: string
          created_at?: string
          id?: string
          locale?: string
          patient_id?: string | null
          persona?: Database["public"]["Enums"]["agent_persona"]
          status?: string
          title?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          clinic_id?: string
          created_at?: string
          id?: string
          locale?: string
          patient_id?: string | null
          persona?: Database["public"]["Enums"]["agent_persona"]
          status?: string
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_conversations_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_conversations_patient_clinic_fkey"
            columns: ["patient_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "agent_conversations_user_clinic_fkey"
            columns: ["user_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "clinic_id"]
          },
        ]
      }
      agent_messages: {
        Row: {
          clinic_id: string
          content: string
          conversation_id: string
          created_at: string
          id: string
          role: Database["public"]["Enums"]["agent_message_role"]
          tool_name: string | null
        }
        Insert: {
          clinic_id: string
          content?: string
          conversation_id: string
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["agent_message_role"]
          tool_name?: string | null
        }
        Update: {
          clinic_id?: string
          content?: string
          conversation_id?: string
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["agent_message_role"]
          tool_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_messages_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_messages_conversation_clinic_fkey"
            columns: ["conversation_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "agent_conversations"
            referencedColumns: ["id", "clinic_id"]
          },
        ]
      }
      ai_budget_periods: {
        Row: {
          addon_limit_micros: number
          budget_limit_micros: number
          clinic_id: string
          created_at: string
          included_limit_micros: number
          overage_limit_micros: number
          period_start: string
          reserved_micros: number
          spent_micros: number
          updated_at: string
        }
        Insert: {
          addon_limit_micros?: number
          budget_limit_micros: number
          clinic_id: string
          created_at?: string
          included_limit_micros?: number
          overage_limit_micros?: number
          period_start: string
          reserved_micros?: number
          spent_micros?: number
          updated_at?: string
        }
        Update: {
          addon_limit_micros?: number
          budget_limit_micros?: number
          clinic_id?: string
          created_at?: string
          included_limit_micros?: number
          overage_limit_micros?: number
          period_start?: string
          reserved_micros?: number
          spent_micros?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_budget_periods_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_commercial_terms: {
        Row: {
          addon_budget_micros: number
          change_reason: string
          clinic_id: string
          created_at: string
          included_budget_override_micros: number | null
          overage_budget_micros: number
          overage_mode: string
          updated_at: string
          updated_by: string
        }
        Insert: {
          addon_budget_micros?: number
          change_reason: string
          clinic_id: string
          created_at?: string
          included_budget_override_micros?: number | null
          overage_budget_micros?: number
          overage_mode?: string
          updated_at?: string
          updated_by: string
        }
        Update: {
          addon_budget_micros?: number
          change_reason?: string
          clinic_id?: string
          created_at?: string
          included_budget_override_micros?: number | null
          overage_budget_micros?: number
          overage_mode?: string
          updated_at?: string
          updated_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_commercial_terms_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: true
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_clinic_provider_policies: {
        Row: {
          clinic_id: string
          created_at: string
          credential_mode: string
          hybrid_accepted_at: string | null
          hybrid_accepted_by: string | null
          hybrid_disclosure_version: string | null
          provider: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          clinic_id: string
          created_at?: string
          credential_mode?: string
          hybrid_accepted_at?: string | null
          hybrid_accepted_by?: string | null
          hybrid_disclosure_version?: string | null
          provider?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          clinic_id?: string
          created_at?: string
          credential_mode?: string
          hybrid_accepted_at?: string | null
          hybrid_accepted_by?: string | null
          hybrid_disclosure_version?: string | null
          provider?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_clinic_provider_policies_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: true
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_clinic_provider_policies_hybrid_accepted_by_fkey"
            columns: ["hybrid_accepted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_clinic_provider_policies_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_provider_connections: {
        Row: {
          activated_at: string
          clinic_id: string
          created_at: string
          created_by: string | null
          credential_encrypted: string | null
          encryption_key_version: number
          health_status: string
          id: string
          last_error_code: string | null
          lifecycle_status: string
          masked_fingerprint: string
          provider: string
          retired_at: string | null
          revoked_at: string | null
          rotated_at: string | null
          tested_at: string
          updated_at: string
        }
        Insert: {
          activated_at?: string
          clinic_id: string
          created_at?: string
          created_by?: string | null
          credential_encrypted?: string | null
          encryption_key_version: number
          health_status: string
          id: string
          last_error_code?: string | null
          lifecycle_status: string
          masked_fingerprint: string
          provider: string
          retired_at?: string | null
          revoked_at?: string | null
          rotated_at?: string | null
          tested_at?: string
          updated_at?: string
        }
        Update: {
          activated_at?: string
          clinic_id?: string
          created_at?: string
          created_by?: string | null
          credential_encrypted?: string | null
          encryption_key_version?: number
          health_status?: string
          id?: string
          last_error_code?: string | null
          lifecycle_status?: string
          masked_fingerprint?: string
          provider?: string
          retired_at?: string | null
          revoked_at?: string | null
          rotated_at?: string | null
          tested_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_provider_connections_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_provider_connections_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_budget_reservations: {
        Row: {
          actor_id: string
          actual_cost_micros: number | null
          certification_version: string
          clinic_id: string
          created_at: string
          credential_mode: string
          error_class: string | null
          expected_model: string
          expected_provider: string
          expires_at: string
          fallback_model_aliases: string[]
          finalized_at: string | null
          id: string
          lease_token: string
          legacy_usage_amount: number
          managed_billing_disposition: string
          model_alias: string
          outcome: string | null
          period_start: string
          persona: string
          policy_version: string
          privacy_policy_version: string
          request_id: string
          reserved_at: string
          reserved_cost_micros: number
          status: string
          surface: string
          task: string
          transport: string
        }
        Insert: {
          actor_id: string
          actual_cost_micros?: number | null
          certification_version: string
          clinic_id: string
          created_at?: string
          credential_mode?: string
          error_class?: string | null
          expected_model: string
          expected_provider: string
          expires_at: string
          fallback_model_aliases?: string[]
          finalized_at?: string | null
          id?: string
          lease_token: string
          legacy_usage_amount?: number
          managed_billing_disposition?: string
          model_alias: string
          outcome?: string | null
          period_start: string
          persona: string
          policy_version: string
          privacy_policy_version: string
          request_id: string
          reserved_at?: string
          reserved_cost_micros: number
          status?: string
          surface: string
          task: string
          transport: string
        }
        Update: {
          actor_id?: string
          actual_cost_micros?: number | null
          certification_version?: string
          clinic_id?: string
          created_at?: string
          credential_mode?: string
          error_class?: string | null
          expected_model?: string
          expected_provider?: string
          expires_at?: string
          fallback_model_aliases?: string[]
          finalized_at?: string | null
          id?: string
          lease_token?: string
          legacy_usage_amount?: number
          managed_billing_disposition?: string
          model_alias?: string
          outcome?: string | null
          period_start?: string
          persona?: string
          policy_version?: string
          privacy_policy_version?: string
          request_id?: string
          reserved_at?: string
          reserved_cost_micros?: number
          status?: string
          surface?: string
          task?: string
          transport?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_budget_reservations_period_fkey"
            columns: ["clinic_id", "period_start"]
            isOneToOne: false
            referencedRelation: "ai_budget_periods"
            referencedColumns: ["clinic_id", "period_start"]
          },
        ]
      }
      ai_usage_events: {
        Row: {
          actor_id: string
          attempt_id: string
          attempt_sequence: number
          billing_disposition: string
          cache_write_tokens: number | null
          cached_input_tokens: number | null
          certification_version: string
          clinic_id: string
          created_at: string
          credential_mode: string
          error_class: string | null
          estimated_cost_micros: number
          fallback_parent_attempt_id: string | null
          final_cost_micros: number
          id: string
          input_tokens: number | null
          latency_ms: number | null
          model: string
          model_alias: string
          output_tokens: number | null
          persona: string
          policy_version: string
          privacy_policy_version: string
          provider: string
          reasoning_tokens: number | null
          request_id: string
          reservation_id: string
          status: string
          surface: string
          task: string
          transport: string
        }
        Insert: {
          actor_id: string
          attempt_id: string
          attempt_sequence: number
          billing_disposition: string
          cache_write_tokens?: number | null
          cached_input_tokens?: number | null
          certification_version: string
          clinic_id: string
          created_at?: string
          credential_mode: string
          error_class?: string | null
          estimated_cost_micros: number
          fallback_parent_attempt_id?: string | null
          final_cost_micros: number
          id?: string
          input_tokens?: number | null
          latency_ms?: number | null
          model: string
          model_alias: string
          output_tokens?: number | null
          persona: string
          policy_version: string
          privacy_policy_version: string
          provider: string
          reasoning_tokens?: number | null
          request_id: string
          reservation_id: string
          status: string
          surface: string
          task: string
          transport: string
        }
        Update: {
          actor_id?: string
          attempt_id?: string
          attempt_sequence?: number
          billing_disposition?: string
          cache_write_tokens?: number | null
          cached_input_tokens?: number | null
          certification_version?: string
          clinic_id?: string
          created_at?: string
          credential_mode?: string
          error_class?: string | null
          estimated_cost_micros?: number
          fallback_parent_attempt_id?: string | null
          final_cost_micros?: number
          id?: string
          input_tokens?: number | null
          latency_ms?: number | null
          model?: string
          model_alias?: string
          output_tokens?: number | null
          persona?: string
          policy_version?: string
          privacy_policy_version?: string
          provider?: string
          reasoning_tokens?: number | null
          request_id?: string
          reservation_id?: string
          status?: string
          surface?: string
          task?: string
          transport?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_usage_events_reservation_fkey"
            columns: ["reservation_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "ai_budget_reservations"
            referencedColumns: ["id", "clinic_id"]
          },
        ]
      }
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
          displaced_at: string | null
          displaced_by: string | null
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
          package_id: string | null
          package_session_number: number | null
          paid_amount: number | null
          paid_at: string | null
          patient_id: string
          payment_method: Database["public"]["Enums"]["payment_method"] | null
          payment_note: string | null
          reminder_sent_at: string | null
          reminders_sent: Json
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
          displaced_at?: string | null
          displaced_by?: string | null
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
          package_id?: string | null
          package_session_number?: number | null
          paid_amount?: number | null
          paid_at?: string | null
          patient_id: string
          payment_method?: Database["public"]["Enums"]["payment_method"] | null
          payment_note?: string | null
          reminder_sent_at?: string | null
          reminders_sent?: Json
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
          displaced_at?: string | null
          displaced_by?: string | null
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
          package_id?: string | null
          package_session_number?: number | null
          paid_amount?: number | null
          paid_at?: string | null
          patient_id?: string
          payment_method?: Database["public"]["Enums"]["payment_method"] | null
          payment_note?: string | null
          reminder_sent_at?: string | null
          reminders_sent?: Json
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
            foreignKeyName: "appointments_displaced_by_fkey"
            columns: ["displaced_by"]
            isOneToOne: false
            referencedRelation: "profiles"
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
            foreignKeyName: "appointments_package_id_fkey"
            columns: ["package_id"]
            isOneToOne: false
            referencedRelation: "patient_packages"
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
      clinic_channels: {
        Row: {
          channel: Database["public"]["Enums"]["message_channel"]
          clinic_id: string
          connected_at: string | null
          created_at: string
          credentials_encrypted: string | null
          id: string
          provider: Database["public"]["Enums"]["messaging_provider"]
          sender_identity: string
          status: Database["public"]["Enums"]["clinic_channel_status"]
          updated_at: string
        }
        Insert: {
          channel: Database["public"]["Enums"]["message_channel"]
          clinic_id: string
          connected_at?: string | null
          created_at?: string
          credentials_encrypted?: string | null
          id?: string
          provider: Database["public"]["Enums"]["messaging_provider"]
          sender_identity: string
          status?: Database["public"]["Enums"]["clinic_channel_status"]
          updated_at?: string
        }
        Update: {
          channel?: Database["public"]["Enums"]["message_channel"]
          clinic_id?: string
          connected_at?: string | null
          created_at?: string
          credentials_encrypted?: string | null
          id?: string
          provider?: Database["public"]["Enums"]["messaging_provider"]
          sender_identity?: string
          status?: Database["public"]["Enums"]["clinic_channel_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "clinic_channels_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
        ]
      }
      clinic_faq: {
        Row: {
          answer: string
          clinic_id: string
          created_at: string
          id: string
          is_active: boolean
          language: string
          question: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          answer: string
          clinic_id: string
          created_at?: string
          id?: string
          is_active?: boolean
          language?: string
          question: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          answer?: string
          clinic_id?: string
          created_at?: string
          id?: string
          is_active?: boolean
          language?: string
          question?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "clinic_faq_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
        ]
      }
      clinic_feature_overrides: {
        Row: {
          clinic_id: string
          created_at: string
          enabled: boolean
          feature_key: string
          id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          clinic_id: string
          created_at?: string
          enabled: boolean
          feature_key: string
          id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          clinic_id?: string
          created_at?: string
          enabled?: boolean
          feature_key?: string
          id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "clinic_feature_overrides_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
        ]
      }
      clinic_invitations: {
        Row: {
          accepted_at: string | null
          accepted_clinic_id: string | null
          clinic_name: string
          created_at: string
          email: string
          email_sent_at: string | null
          expires_at: string | null
          id: string
          invited_by: string | null
          owner_name: string
          phone: string
          phone_e164_valid: boolean
          revoked_at: string | null
          status: Database["public"]["Enums"]["clinic_invitation_status"]
          token_hash: string | null
          updated_at: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_clinic_id?: string | null
          clinic_name: string
          created_at?: string
          email: string
          email_sent_at?: string | null
          expires_at?: string | null
          id?: string
          invited_by?: string | null
          owner_name: string
          phone: string
          phone_e164_valid?: boolean
          revoked_at?: string | null
          status?: Database["public"]["Enums"]["clinic_invitation_status"]
          token_hash?: string | null
          updated_at?: string
        }
        Update: {
          accepted_at?: string | null
          accepted_clinic_id?: string | null
          clinic_name?: string
          created_at?: string
          email?: string
          email_sent_at?: string | null
          expires_at?: string | null
          id?: string
          invited_by?: string | null
          owner_name?: string
          phone?: string
          phone_e164_valid?: boolean
          revoked_at?: string | null
          status?: Database["public"]["Enums"]["clinic_invitation_status"]
          token_hash?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "clinic_invitations_accepted_clinic_id_fkey"
            columns: ["accepted_clinic_id"]
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
          country: string
          created_at: string
          currency: string
          digits: string
          id: string
          is_active: boolean
          locale: string
          logo_url: string | null
          name: string
          onboarding_completed_at: string | null
          phone: string | null
          phone_e164_valid: boolean
          invoice_followup_email_body: string | null
          invoice_followup_email_subject: string | null
          invoice_followup_first_days: number
          invoice_followup_second_days: number
          invoice_followups_enabled: boolean
          reminder_lead_hours: number
          reminder_offsets: number[]
          reminders_enabled: boolean
          time_format: string
          timezone: string
          updated_at: string
          week_start: number
          working_hours_end: string | null
          working_hours_start: string | null
        }
        Insert: {
          address?: string | null
          country?: string
          created_at?: string
          currency?: string
          digits?: string
          id?: string
          is_active?: boolean
          locale?: string
          logo_url?: string | null
          name: string
          onboarding_completed_at?: string | null
          phone?: string | null
          phone_e164_valid?: boolean
          invoice_followup_email_body?: string | null
          invoice_followup_email_subject?: string | null
          invoice_followup_first_days?: number
          invoice_followup_second_days?: number
          invoice_followups_enabled?: boolean
          reminder_lead_hours?: number
          reminder_offsets?: number[]
          reminders_enabled?: boolean
          time_format?: string
          timezone?: string
          updated_at?: string
          week_start?: number
          working_hours_end?: string | null
          working_hours_start?: string | null
        }
        Update: {
          address?: string | null
          country?: string
          created_at?: string
          currency?: string
          digits?: string
          id?: string
          is_active?: boolean
          locale?: string
          logo_url?: string | null
          name?: string
          onboarding_completed_at?: string | null
          phone?: string | null
          phone_e164_valid?: boolean
          invoice_followup_email_body?: string | null
          invoice_followup_email_subject?: string | null
          invoice_followup_first_days?: number
          invoice_followup_second_days?: number
          invoice_followups_enabled?: boolean
          reminder_lead_hours?: number
          reminder_offsets?: number[]
          reminders_enabled?: boolean
          time_format?: string
          timezone?: string
          updated_at?: string
          week_start?: number
          working_hours_end?: string | null
          working_hours_start?: string | null
        }
        Relationships: []
      }
      conversations: {
        Row: {
          assigned_to: string | null
          channel: Database["public"]["Enums"]["message_channel"]
          clinic_id: string
          created_at: string
          id: string
          last_message_at: string | null
          patient_id: string | null
          participant_address: string | null
          patient_link_status: string
          status: Database["public"]["Enums"]["conversation_status"]
          status_updated_at: string
          updated_at: string
          window_expires_at: string | null
        }
        Insert: {
          assigned_to?: string | null
          channel: Database["public"]["Enums"]["message_channel"]
          clinic_id: string
          created_at?: string
          id?: string
          last_message_at?: string | null
          patient_id?: string | null
          participant_address?: string | null
          patient_link_status?: string
          status?: Database["public"]["Enums"]["conversation_status"]
          status_updated_at?: string
          updated_at?: string
          window_expires_at?: string | null
        }
        Update: {
          assigned_to?: string | null
          channel?: Database["public"]["Enums"]["message_channel"]
          clinic_id?: string
          created_at?: string
          id?: string
          last_message_at?: string | null
          patient_id?: string | null
          participant_address?: string | null
          patient_link_status?: string
          status?: Database["public"]["Enums"]["conversation_status"]
          status_updated_at?: string
          updated_at?: string
          window_expires_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "conversations_assignee_clinic_fkey"
            columns: ["assigned_to", "clinic_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "conversations_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_patient_clinic_fkey"
            columns: ["patient_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "conversations_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
        ]
      }
      coupon_redemptions: {
        Row: {
          clinic_id: string
          coupon_id: string
          id: string
          redeemed_at: string
          subscription_id: string
        }
        Insert: {
          clinic_id: string
          coupon_id: string
          id?: string
          redeemed_at?: string
          subscription_id: string
        }
        Update: {
          clinic_id?: string
          coupon_id?: string
          id?: string
          redeemed_at?: string
          subscription_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "coupon_redemptions_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "coupon_redemptions_coupon_id_fkey"
            columns: ["coupon_id"]
            isOneToOne: false
            referencedRelation: "coupons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "coupon_redemptions_subscription_clinic_fkey"
            columns: ["subscription_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "coupon_redemptions_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
        ]
      }
      coupons: {
        Row: {
          clinic_id: string | null
          code: string
          created_at: string
          expires_at: string | null
          id: string
          invitation_id: string | null
          is_active: boolean
          kind: Database["public"]["Enums"]["coupon_kind"]
          max_redemptions: number | null
          months: number | null
          percent: number | null
          redemption_count: number
          updated_at: string
        }
        Insert: {
          clinic_id?: string | null
          code: string
          created_at?: string
          expires_at?: string | null
          id?: string
          invitation_id?: string | null
          is_active?: boolean
          kind: Database["public"]["Enums"]["coupon_kind"]
          max_redemptions?: number | null
          months?: number | null
          percent?: number | null
          redemption_count?: number
          updated_at?: string
        }
        Update: {
          clinic_id?: string | null
          code?: string
          created_at?: string
          expires_at?: string | null
          id?: string
          invitation_id?: string | null
          is_active?: boolean
          kind?: Database["public"]["Enums"]["coupon_kind"]
          max_redemptions?: number | null
          months?: number | null
          percent?: number | null
          redemption_count?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "coupons_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "coupons_invitation_id_fkey"
            columns: ["invitation_id"]
            isOneToOne: false
            referencedRelation: "clinic_invitations"
            referencedColumns: ["id"]
          },
        ]
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
          search_name: string | null
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
      followup_sequences: {
        Row: {
          appointment_id: string
          clinic_id: string
          created_at: string
          id: string
          last_sent_at: string | null
          next_run_at: string | null
          status: string
          step: number
          stopped_reason: string | null
          updated_at: string
        }
        Insert: {
          appointment_id: string
          clinic_id: string
          created_at?: string
          id?: string
          last_sent_at?: string | null
          next_run_at?: string | null
          status?: string
          step?: number
          stopped_reason?: string | null
          updated_at?: string
        }
        Update: {
          appointment_id?: string
          clinic_id?: string
          created_at?: string
          id?: string
          last_sent_at?: string | null
          next_run_at?: string | null
          status?: string
          step?: number
          stopped_reason?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "followup_sequences_appointment_clinic_fkey"
            columns: ["appointment_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "appointments"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "followup_sequences_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
        ]
      }
      fx_rates: {
        Row: {
          base_currency: string
          currency_code: string
          fetched_at: string
          provider: string
          provider_timestamp: string
          rate: number
          updated_at: string
        }
        Insert: {
          base_currency?: string
          currency_code: string
          fetched_at?: string
          provider: string
          provider_timestamp: string
          rate: number
          updated_at?: string
        }
        Update: {
          base_currency?: string
          currency_code?: string
          fetched_at?: string
          provider?: string
          provider_timestamp?: string
          rate?: number
          updated_at?: string
        }
        Relationships: []
      }
      inbound_messages: {
        Row: {
          body: string
          channel: Database["public"]["Enums"]["message_channel"]
          clinic_id: string
          conversation_id: string
          created_at: string
          id: string
          patient_id: string | null
          provider_message_id: string | null
          received_at: string
          sender: string
        }
        Insert: {
          body: string
          channel: Database["public"]["Enums"]["message_channel"]
          clinic_id: string
          conversation_id: string
          created_at?: string
          id?: string
          patient_id?: string | null
          provider_message_id?: string | null
          received_at?: string
          sender: string
        }
        Update: {
          body?: string
          channel?: Database["public"]["Enums"]["message_channel"]
          clinic_id?: string
          conversation_id?: string
          created_at?: string
          id?: string
          patient_id?: string | null
          provider_message_id?: string | null
          received_at?: string
          sender?: string
        }
        Relationships: [
          {
            foreignKeyName: "inbound_messages_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inbound_messages_conversation_clinic_fkey"
            columns: ["conversation_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "inbound_messages_patient_clinic_fkey"
            columns: ["patient_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "inbound_messages_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
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
      message_dispatches: {
        Row: {
          channel: Database["public"]["Enums"]["message_channel"]
          claimed_at: string | null
          clinic_id: string
          created_at: string
          dedupe_key: string
          id: string
          outbound_message_id: string | null
          sent_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          channel: Database["public"]["Enums"]["message_channel"]
          claimed_at?: string | null
          clinic_id: string
          created_at?: string
          dedupe_key: string
          id?: string
          outbound_message_id?: string | null
          sent_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          channel?: Database["public"]["Enums"]["message_channel"]
          claimed_at?: string | null
          clinic_id?: string
          created_at?: string
          dedupe_key?: string
          id?: string
          outbound_message_id?: string | null
          sent_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_dispatches_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
        ]
      }
      message_templates: {
        Row: {
          approval_status: Database["public"]["Enums"]["template_approval_status"]
          body: string
          channel: Database["public"]["Enums"]["message_channel"]
          clinic_id: string
          created_at: string
          id: string
          language: string
          name: string
          provider_template_id: string | null
          updated_at: string
          variables: Json
        }
        Insert: {
          approval_status?: Database["public"]["Enums"]["template_approval_status"]
          body: string
          channel: Database["public"]["Enums"]["message_channel"]
          clinic_id: string
          created_at?: string
          id?: string
          language: string
          name: string
          provider_template_id?: string | null
          updated_at?: string
          variables?: Json
        }
        Update: {
          approval_status?: Database["public"]["Enums"]["template_approval_status"]
          body?: string
          channel?: Database["public"]["Enums"]["message_channel"]
          clinic_id?: string
          created_at?: string
          id?: string
          language?: string
          name?: string
          provider_template_id?: string | null
          updated_at?: string
          variables?: Json
        }
        Relationships: [
          {
            foreignKeyName: "message_templates_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          body: string | null
          clinic_id: string
          created_at: string
          data: Json
          dedupe_key: string | null
          id: string
          link: string | null
          read_at: string | null
          recipient_id: string | null
          title: string | null
          type: string
        }
        Insert: {
          body?: string | null
          clinic_id: string
          created_at?: string
          data?: Json
          dedupe_key?: string | null
          id?: string
          link?: string | null
          read_at?: string | null
          recipient_id?: string | null
          title?: string | null
          type: string
        }
        Update: {
          body?: string | null
          clinic_id?: string
          created_at?: string
          data?: Json
          dedupe_key?: string | null
          id?: string
          link?: string | null
          read_at?: string | null
          recipient_id?: string | null
          title?: string | null
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_recipient_clinic_fkey"
            columns: ["recipient_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "clinic_id"]
          },
          {
            foreignKeyName: "notifications_recipient_id_fkey"
            columns: ["recipient_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      outbound_messages: {
        Row: {
          body_preview: string | null
          channel: Database["public"]["Enums"]["message_channel"]
          clinic_id: string
          cost_micro: number | null
          created_at: string
          error: string | null
          id: string
          provider: Database["public"]["Enums"]["messaging_provider"]
          provider_message_id: string | null
          recipient: string
          related_id: string | null
          related_type: Database["public"]["Enums"]["outbound_related_type"]
          status: Database["public"]["Enums"]["outbound_message_status"]
          status_updated_at: string
          template_id: string | null
        }
        Insert: {
          body_preview?: string | null
          channel: Database["public"]["Enums"]["message_channel"]
          clinic_id: string
          cost_micro?: number | null
          created_at?: string
          error?: string | null
          id?: string
          provider: Database["public"]["Enums"]["messaging_provider"]
          provider_message_id?: string | null
          recipient: string
          related_id?: string | null
          related_type: Database["public"]["Enums"]["outbound_related_type"]
          status?: Database["public"]["Enums"]["outbound_message_status"]
          status_updated_at?: string
          template_id?: string | null
        }
        Update: {
          body_preview?: string | null
          channel?: Database["public"]["Enums"]["message_channel"]
          clinic_id?: string
          cost_micro?: number | null
          created_at?: string
          error?: string | null
          id?: string
          provider?: Database["public"]["Enums"]["messaging_provider"]
          provider_message_id?: string | null
          recipient?: string
          related_id?: string | null
          related_type?: Database["public"]["Enums"]["outbound_related_type"]
          status?: Database["public"]["Enums"]["outbound_message_status"]
          status_updated_at?: string
          template_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "outbound_messages_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "outbound_messages_template_clinic_fkey"
            columns: ["template_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "message_templates"
            referencedColumns: ["id", "clinic_id"]
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
      package_templates: {
        Row: {
          clinic_id: string
          created_at: string
          created_by: string | null
          department_id: string
          id: string
          is_active: boolean
          name: string
          notes: string | null
          price_per_session: number | null
          total_price: number | null
          total_sessions: number
          updated_at: string
        }
        Insert: {
          clinic_id: string
          created_at?: string
          created_by?: string | null
          department_id: string
          id?: string
          is_active?: boolean
          name: string
          notes?: string | null
          price_per_session?: number | null
          total_price?: number | null
          total_sessions: number
          updated_at?: string
        }
        Update: {
          clinic_id?: string
          created_at?: string
          created_by?: string | null
          department_id?: string
          id?: string
          is_active?: boolean
          name?: string
          notes?: string | null
          price_per_session?: number | null
          total_price?: number | null
          total_sessions?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "package_templates_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "package_templates_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "package_templates_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
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
      patient_packages: {
        Row: {
          clinic_id: string
          created_at: string
          created_by: string | null
          department_id: string | null
          id: string
          is_active: boolean
          name: string
          notes: string | null
          patient_id: string
          price_per_session: number | null
          service_id: string | null
          total_sessions: number
          updated_at: string
          used_sessions: number
        }
        Insert: {
          clinic_id: string
          created_at?: string
          created_by?: string | null
          department_id?: string | null
          id?: string
          is_active?: boolean
          name: string
          notes?: string | null
          patient_id: string
          price_per_session?: number | null
          service_id?: string | null
          total_sessions: number
          updated_at?: string
          used_sessions?: number
        }
        Update: {
          clinic_id?: string
          created_at?: string
          created_by?: string | null
          department_id?: string | null
          id?: string
          is_active?: boolean
          name?: string
          notes?: string | null
          patient_id?: string
          price_per_session?: number | null
          service_id?: string | null
          total_sessions?: number
          updated_at?: string
          used_sessions?: number
        }
        Relationships: [
          {
            foreignKeyName: "patient_packages_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_packages_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_packages_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_packages_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patient_packages_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      patients: {
        Row: {
          archived_at: string | null
          assigned_doctor_id: string | null
          avatar_path: string | null
          blood_type: Database["public"]["Enums"]["blood_type"] | null
          clinic_id: string
          created_at: string
          created_by: string
          date_of_birth: string
          deleted_at: string | null
          department_id: string | null
          email: string
          file_number: string
          full_name: string
          id: string
          insurance_provider_id: string | null
          is_archived: boolean
          is_deleted: boolean
          national_id: string
          phone: string
          phone_e164_valid: boolean
          search_name: string | null
          search_phone: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          archived_at?: string | null
          assigned_doctor_id?: string | null
          avatar_path?: string | null
          blood_type?: Database["public"]["Enums"]["blood_type"] | null
          clinic_id: string
          created_at?: string
          created_by: string
          date_of_birth: string
          deleted_at?: string | null
          department_id?: string | null
          email: string
          file_number: string
          full_name: string
          id?: string
          insurance_provider_id?: string | null
          is_archived?: boolean
          is_deleted?: boolean
          national_id: string
          phone: string
          phone_e164_valid?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          archived_at?: string | null
          assigned_doctor_id?: string | null
          avatar_path?: string | null
          blood_type?: Database["public"]["Enums"]["blood_type"] | null
          clinic_id?: string
          created_at?: string
          created_by?: string
          date_of_birth?: string
          deleted_at?: string | null
          department_id?: string | null
          email?: string
          file_number?: string
          full_name?: string
          id?: string
          insurance_provider_id?: string | null
          is_archived?: boolean
          is_deleted?: boolean
          national_id?: string
          phone?: string
          phone_e164_valid?: boolean
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
      plans: {
        Row: {
          created_at: string
          features: Json
          id: string
          is_active: boolean
          limits: Json
          monthly_price_usd: number
          name_ar: string
          name_en: string
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          features?: Json
          id?: string
          is_active?: boolean
          limits?: Json
          monthly_price_usd?: number
          name_ar: string
          name_en: string
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          features?: Json
          id?: string
          is_active?: boolean
          limits?: Json
          monthly_price_usd?: number
          name_ar?: string
          name_en?: string
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      platform_admins: {
        Row: {
          created_at: string
          created_by: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          user_id?: string
        }
        Relationships: []
      }
      platform_audit_logs: {
        Row: {
          action: string
          actor_user_id: string | null
          clinic_id: string | null
          created_at: string
          id: string
          payload: Json
          target_id: string | null
          target_type: string
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          clinic_id?: string | null
          created_at?: string
          id?: string
          payload?: Json
          target_id?: string | null
          target_type: string
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          clinic_id?: string | null
          created_at?: string
          id?: string
          payload?: Json
          target_id?: string | null
          target_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "platform_audit_logs_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_settings: {
        Row: {
          id: boolean
          invitation_expiry_days: number
          registration_mode: Database["public"]["Enums"]["registration_mode"]
          updated_at: string
          updated_by: string | null
          weekly_invite_limit: number
        }
        Insert: {
          id?: boolean
          invitation_expiry_days?: number
          registration_mode?: Database["public"]["Enums"]["registration_mode"]
          updated_at?: string
          updated_by?: string | null
          weekly_invite_limit?: number
        }
        Update: {
          id?: boolean
          invitation_expiry_days?: number
          registration_mode?: Database["public"]["Enums"]["registration_mode"]
          updated_at?: string
          updated_by?: string | null
          weekly_invite_limit?: number
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          clinic_id: string
          created_at: string
          deleted_at: string | null
          department_id: string | null
          display_currency: string | null
          full_name: string
          id: string
          is_active: boolean
          is_deleted: boolean
          last_login_at: string | null
          must_change_password: boolean
          phone: string | null
          phone_e164_valid: boolean
          role: Database["public"]["Enums"]["user_role"]
          search_name: string | null
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          clinic_id: string
          created_at?: string
          deleted_at?: string | null
          department_id?: string | null
          display_currency?: string | null
          full_name: string
          id: string
          is_active?: boolean
          is_deleted?: boolean
          last_login_at?: string | null
          must_change_password?: boolean
          phone?: string | null
          phone_e164_valid?: boolean
          role: Database["public"]["Enums"]["user_role"]
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          clinic_id?: string
          created_at?: string
          deleted_at?: string | null
          department_id?: string | null
          display_currency?: string | null
          full_name?: string
          id?: string
          is_active?: boolean
          is_deleted?: boolean
          last_login_at?: string | null
          must_change_password?: boolean
          phone?: string | null
          phone_e164_valid?: boolean
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
          search_name: string | null
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
          phone: string | null
          phone_e164_valid: boolean
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
          phone?: string | null
          phone_e164_valid?: boolean
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
          phone?: string | null
          phone_e164_valid?: boolean
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
      subscriptions: {
        Row: {
          clinic_id: string
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          id: string
          plan_id: string
          provider: string
          provider_subscription_id: string | null
          status: Database["public"]["Enums"]["subscription_status"]
          trial_ends_at: string | null
          updated_at: string
        }
        Insert: {
          clinic_id: string
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          plan_id: string
          provider?: string
          provider_subscription_id?: string | null
          status?: Database["public"]["Enums"]["subscription_status"]
          trial_ends_at?: string | null
          updated_at?: string
        }
        Update: {
          clinic_id?: string
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          plan_id?: string
          provider?: string
          provider_subscription_id?: string | null
          status?: Database["public"]["Enums"]["subscription_status"]
          trial_ends_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: true
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriptions_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id"]
          },
        ]
      }
      usage_counters: {
        Row: {
          clinic_id: string
          created_at: string
          id: string
          limit_snapshot: number
          metric: Database["public"]["Enums"]["usage_metric"]
          period_start: string
          updated_at: string
          used: number
        }
        Insert: {
          clinic_id: string
          created_at?: string
          id?: string
          limit_snapshot: number
          metric: Database["public"]["Enums"]["usage_metric"]
          period_start: string
          updated_at?: string
          used?: number
        }
        Update: {
          clinic_id?: string
          created_at?: string
          id?: string
          limit_snapshot?: number
          metric?: Database["public"]["Enums"]["usage_metric"]
          period_start?: string
          updated_at?: string
          used?: number
        }
        Relationships: [
          {
            foreignKeyName: "usage_counters_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
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
      user_ai_permissions: {
        Row: {
          clinic_id: string
          created_at: string
          granted: boolean
          permission_key: string
          updated_at: string
          updated_by: string | null
          user_id: string
        }
        Insert: {
          clinic_id: string
          created_at?: string
          granted?: boolean
          permission_key: string
          updated_at?: string
          updated_by?: string | null
          user_id: string
        }
        Update: {
          clinic_id?: string
          created_at?: string
          granted?: boolean
          permission_key?: string
          updated_at?: string
          updated_by?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_ai_permissions_clinic_id_fkey"
            columns: ["clinic_id"]
            isOneToOne: false
            referencedRelation: "clinics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_ai_permissions_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_ai_permissions_user_clinic_fk"
            columns: ["user_id", "clinic_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "clinic_id"]
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
      user_ui_preferences: {
        Row: {
          created_at: string
          locale: string
          theme: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          locale?: string
          theme?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          locale?: string
          theme?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      ai_compare_revenue_periods: {
        Args: {
          p_a_end: string
          p_a_start: string
          p_b_end: string
          p_b_start: string
        }
        Returns: Json
      }
      ai_get_appointment_stats: {
        Args: { p_end: string; p_group_by?: string; p_start: string }
        Returns: Json
      }
      ai_get_clinic_summary: {
        Args: { p_end: string; p_start: string }
        Returns: Json
      }
      ai_get_patient_stats: {
        Args: { p_end: string; p_group_by?: string; p_start: string }
        Returns: Json
      }
      ai_get_revenue_summary: {
        Args: { p_end: string; p_start: string }
        Returns: Json
      }
      search_departments_ranked: {
        Args: { p_limit?: number; p_query: string; p_query_alt?: string }
        Returns: {
          id: string
          match_kind: string
          name: string
          score: number
        }[]
      }
      search_services_ranked: {
        Args: { p_limit?: number; p_query: string; p_query_alt?: string }
        Returns: {
          department_id: string
          id: string
          match_kind: string
          name: string
          price: number
          score: number
        }[]
      }
      search_staff_ranked: {
        Args: {
          p_limit?: number
          p_query: string
          p_query_alt?: string
          p_role?: Database["public"]["Enums"]["user_role"]
        }
        Returns: {
          department_id: string
          full_name: string
          id: string
          match_kind: string
          role: string
          score: number
        }[]
      }
      activate_ai_provider_connection: {
        Args: {
          p_actor_id: string
          p_clinic_id: string
          p_connection_id: string
          p_credential_encrypted: string
          p_encryption_key_version: number
          p_masked_fingerprint: string
          p_provider: string
        }
        Returns: string
      }
      advance_outbound_message_status: {
        Args: {
          p_client_reference: string | null
          p_error: string | null
          p_expected_clinic_id: string | null
          p_occurred_at: string | null
          p_provider: Database["public"]["Enums"]["messaging_provider"]
          p_provider_message_id: string
          p_status: Database["public"]["Enums"]["outbound_message_status"]
        }
        Returns: boolean
      }
      assert_primary_ai_provider_admin: {
        Args: { p_actor_id: string; p_clinic_id: string }
        Returns: undefined
      }
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
      claim_appointment_reminder: {
        Args: {
          p_appointment_id: string
          p_claimed_at: string
          p_clinic_id: string
          p_offset_hours: number
        }
        Returns: boolean
      }
      claim_message_dispatch: {
        Args: {
          p_channel: Database["public"]["Enums"]["message_channel"]
          p_clinic_id: string
          p_dedupe_key: string
          p_now: string
        }
        Returns: boolean
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
      complete_own_onboarding: { Args: never; Returns: string }
      create_clinic_with_owner: {
        Args: {
          p_clinic_name: string
          p_country: string
          p_invitation_token_hash?: string
          p_locale: string
          p_owner_email: string
          p_owner_id: string
          p_owner_name: string
          p_phone: string
        }
        Returns: string
      }
      emit_clinic_notifications: {
        Args: {
          p_clinic_id: string
          p_data: Json
          p_dedupe_key: string | null
          p_link: string | null
          p_recipient_ids: string[]
          p_type: string
        }
        Returns: number
      }
      finalize_appointment_reminder: {
        Args: {
          p_appointment_id: string
          p_clinic_id: string
          p_offset_hours: number
          p_sent_at: string
        }
        Returns: boolean
      }
      find_resumable_clinic_owner: {
        Args: { p_email: string }
        Returns: {
          email_confirmed: boolean
          user_id: string
        }[]
      }
      finalize_outbound_message: {
        Args: {
          p_clinic_id: string
          p_cost_micro: number | null
          p_error: string | null
          p_occurred_at: string
          p_outbound_message_id: string
          p_provider_message_id: string | null
          p_status: Database["public"]["Enums"]["outbound_message_status"]
        }
        Returns: boolean
      }
      get_cancellation_report: {
        Args: { p_end: string; p_start: string }
        Returns: Json
      }
      get_doctor_performance_report: {
        Args: { p_end: string; p_start: string }
        Returns: Json
      }
      get_followups_dashboard: {
        Args: {
          p_department_id?: string
          p_doctor_id?: string
          p_done_limit?: number
          p_done_offset?: number
          p_end: string
          p_outcome?: Database["public"]["Enums"]["follow_up_outcome"]
          p_patient_ids?: string[]
          p_pending_limit?: number
          p_start: string
        }
        Returns: Json
      }
      get_inbox_conversation_summaries: {
        Args: {
          p_limit?: number
          p_requested_conversation_id?: string | null
        }
        Returns: {
          assigned_to: string | null
          channel: Database["public"]["Enums"]["message_channel"]
          id: string
          last_inbound_at: string | null
          last_message_at: string | null
          participant_address: string | null
          patient_id: string | null
          preview: string
          status: Database["public"]["Enums"]["conversation_status"]
          unread_count: number
          window_expires_at: string | null
        }[]
      }
      get_no_show_report: {
        Args: { p_end: string; p_start: string }
        Returns: Json
      }
      get_public_registration_status: {
        Args: never
        Returns: {
          accepted_clinics_this_week: number
          registration_mode: Database["public"]["Enums"]["registration_mode"]
          weekly_invite_limit: number
        }[]
      }
      get_receptionist_performance_report: {
        Args: { p_end: string; p_start: string }
        Returns: Json
      }
      get_revenue_summary: {
        Args: {
          p_department_id?: string
          p_doctor_id?: string
          p_end: string
          p_patient_ids?: string[]
          p_start: string
        }
        Returns: Json
      }
      increment_usage: {
        Args: {
          p_amount?: number
          p_clinic_id: string
          p_metric: Database["public"]["Enums"]["usage_metric"]
          p_period_start?: string
        }
        Returns: number
      }
      log_ai_provider_fallback: {
        Args: {
          p_actor_id: string
          p_clinic_id: string
          p_error_class: string
          p_provider: string
          p_request_id: string
        }
        Returns: boolean
      }
      operator_ai_usage_report: {
        Args: {
          p_clinic_id?: string
          p_period_from: string
          p_period_to: string
        }
        Returns: {
          budget_limit_micros: number
          clinic_id: string
          clinic_name: string
          managed_spent_micros: number
          period_start: string
          provider_cost_micros: number
          request_limit: number
          request_used: number
          reserved_micros: number
        }[]
      }
      reconcile_ai_budget: {
        Args: {
          p_actual_cost_micros: number
          p_attempts: Json
          p_error_class: string | null
          p_lease_token: string
          p_managed_cost_micros: number
          p_outcome: string
          p_reservation_id: string
        }
        Returns: boolean
      }
      record_ai_provider_connection_test: {
        Args: {
          p_actor_id: string
          p_clinic_id: string
          p_connection_id: string
          p_error_code: string | null
          p_health_status: string
        }
        Returns: boolean
      }
      release_usage: {
        Args: {
          p_amount?: number
          p_clinic_id: string
          p_metric: Database["public"]["Enums"]["usage_metric"]
          p_period_start?: string
        }
        Returns: number
      }
      reserve_ai_budget: {
        Args: {
          p_actor_id: string
          p_budget_limit_micros: number
          p_certification_version: string
          p_clinic_id: string
          p_credential_mode: string
          p_expected_model: string
          p_expected_provider: string
          p_fallback_model_aliases: string[]
          p_lease_seconds: number
          p_lease_token: string
          p_model_alias: string
          p_period_start: string
          p_persona: string
          p_policy_version: string
          p_privacy_policy_version: string
          p_request_id: string
          p_reserved_cost_micros: number
          p_surface: string
          p_task: string
          p_transport: string
        }
        Returns: {
          acquired: boolean
          budget_limit_micros: number
          expires_at: string
          legacy_limit: number
          legacy_used: number
          reservation_id: string
          reservation_status: string
          reserved_cost_micros: number
          returned_lease_token: string
        }[]
      }
      reserve_ai_budget_p45a_limit_v1: {
        Args: {
          p_actor_id: string
          p_budget_limit_micros: number
          p_certification_version: string
          p_clinic_id: string
          p_expected_model: string
          p_expected_provider: string
          p_fallback_model_aliases: string[]
          p_lease_seconds: number
          p_lease_token: string
          p_model_alias: string
          p_period_start: string
          p_persona: string
          p_policy_version: string
          p_privacy_policy_version: string
          p_request_id: string
          p_reserved_cost_micros: number
          p_surface: string
          p_task: string
          p_transport: string
        }
        Returns: {
          acquired: boolean
          budget_limit_micros: number
          expires_at: string
          legacy_limit: number
          legacy_used: number
          reservation_id: string
          reservation_status: string
          reserved_cost_micros: number
          returned_lease_token: string
        }[]
      }
      revoke_ai_provider_connection: {
        Args: {
          p_actor_id: string
          p_clinic_id: string
          p_connection_id: string
        }
        Returns: boolean
      }
      set_ai_provider_policy: {
        Args: {
          p_actor_id: string
          p_clinic_id: string
          p_credential_mode: string
          p_hybrid_disclosure_version: string | null
        }
        Returns: boolean
      }
      is_platform_admin: { Args: never; Returns: boolean }
      list_daily_reminder_candidates: {
        Args: {
          p_horizon: string
          p_limit?: number
          p_now: string
        }
        Returns: {
          clinic_id: string
          doctor_id: string
          id: string
          patient_id: string
          reminders_sent: Json
          scheduled_at: string
          timezone: string
        }[]
      }
      finalize_message_dispatch: {
        Args: {
          p_channel: Database["public"]["Enums"]["message_channel"]
          p_clinic_id: string
          p_dedupe_key: string
          p_outbound_message_id: string
          p_sent_at: string
        }
        Returns: boolean
      }
      release_message_dispatch: {
        Args: {
          p_channel: Database["public"]["Enums"]["message_channel"]
          p_clinic_id: string
          p_dedupe_key: string
        }
        Returns: boolean
      }
      list_reminder_candidates: {
        Args: {
          p_horizon: string
          p_limit?: number
          p_now: string
        }
        Returns: {
          clinic_id: string
          doctor_id: string
          id: string
          patient_id: string
          reminders_sent: Json
          scheduled_at: string
        }[]
      }
      log_agent_tool_call: {
        Args: {
          p_actor_id?: string
          p_clinic_id: string
          p_record_id?: string
          p_summary?: Json
          p_table_name?: string
          p_tool: string
        }
        Returns: string
      }
      log_platform_audit_event: {
        Args: {
          p_action: string
          p_clinic_id?: string
          p_payload?: Json
          p_target_id?: string
          p_target_type: string
        }
        Returns: string
      }
      normalize_legacy_phone_e164: {
        Args: { default_country: string; value: string }
        Returns: string
      }
      platform_week_start: { Args: { p_at?: string }; Returns: string }
      search_patients_ranked: {
        Args: { p_limit?: number; p_query: string; p_query_alt?: string }
        Returns: {
          email: string
          file_number: string
          full_name: string
          id: string
          match_kind: string
          phone: string
          score: number
        }[]
      }
      persist_whatsapp_inbound: {
        Args: {
          p_body: string
          p_clinic_id: string
          p_provider_message_id: string
          p_received_at: string
          p_sender: string
        }
        Returns: {
          conversation_id: string
          inserted: boolean
        }[]
      }
      record_own_last_login: { Args: never; Returns: boolean }
      redeem_coupon: {
        Args: { p_clinic_id: string; p_code: string; p_invitation_id?: string }
        Returns: Json
      }
      release_appointment_reminder: {
        Args: {
          p_appointment_id: string
          p_clinic_id: string
          p_offset_hours: number
        }
        Returns: boolean
      }
      request_clinic_invitation: {
        Args: {
          p_clinic_name: string
          p_email: string
          p_owner_name: string
          p_phone: string
        }
        Returns: string
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
      set_conversation_patient: {
        Args: {
          p_clinic_id: string
          p_conversation_id: string
          p_patient_id: string | null
        }
        Returns: boolean
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      soft_delete_medical_note_attachment: {
        Args: {
          p_attachment_id: string
          p_note_id: string
          p_patient_id: string
        }
        Returns: boolean
      }
      soft_delete_patient: { Args: { p_patient_id: string }; Returns: boolean }
      soft_delete_patient_document: {
        Args: { p_document_id: string; p_patient_id: string }
        Returns: boolean
      }
      start_appointment_session: {
        Args: { p_appointment_id: string }
        Returns: {
          patient_id: string
          status: Database["public"]["Enums"]["appointment_status"]
        }[]
      }
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
      undo_appointment_status: {
        Args: { p_appointment_id: string; p_target_status: string }
        Returns: undefined
      }
      valid_reminder_offsets: {
        Args: { p_offsets: number[] }
        Returns: boolean
      }
      validate_clinic_signup: {
        Args: { p_token_hash?: string }
        Returns: {
          allowed: boolean
          clinic_name: string
          email: string
          invitation_id: string
          owner_name: string
          reason: string
        }[]
      }
    }
    Enums: {
      agent_message_role: "user" | "assistant" | "tool"
      agent_persona: "doctor" | "patient"
      appointment_status:
        | "pending"
        | "confirmed"
        | "arrived"
        | "in_session"
        | "completed"
        | "cancelled"
        | "no_show"
      blood_type: "A+" | "A-" | "B+" | "B-" | "AB+" | "AB-" | "O+" | "O-"
      clinic_channel_status: "pending" | "active" | "error"
      clinic_invitation_status: "pending" | "accepted" | "revoked" | "expired"
      conversation_status: "open" | "closed"
      coupon_kind: "lifetime_free" | "months_free" | "percent_discount"
      follow_up_outcome: "all_fine" | "has_problem" | "no_response"
      message_channel: "whatsapp" | "email"
      messaging_provider: "dialog360" | "meta" | "resend"
      outbound_message_status: "queued" | "sent" | "delivered" | "read" | "failed"
      outbound_related_type: "appointment" | "invoice" | "agent" | "manual"
      patient_document_category: "national_id" | "insurance" | "other"
      payment_method:
        | "cash"
        | "credit_card"
        | "paypal"
        | "bank_transfer"
        | "insurance"
      registration_mode: "invite_only" | "open"
      subscription_status: "trialing" | "active" | "past_due" | "cancelled"
      template_approval_status: "draft" | "submitted" | "approved" | "rejected"
      usage_metric: "ai_messages" | "wa_messages" | "sms_messages" | "emails"
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
  public: {
    Enums: {
      agent_message_role: ["user", "assistant", "tool"],
      agent_persona: ["doctor", "patient"],
      appointment_status: [
        "pending",
        "confirmed",
        "arrived",
        "in_session",
        "completed",
        "cancelled",
        "no_show",
      ],
      blood_type: ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"],
      clinic_channel_status: ["pending", "active", "error"],
      clinic_invitation_status: ["pending", "accepted", "revoked", "expired"],
      conversation_status: ["open", "closed"],
      coupon_kind: ["lifetime_free", "months_free", "percent_discount"],
      follow_up_outcome: ["all_fine", "has_problem", "no_response"],
      message_channel: ["whatsapp", "email"],
      messaging_provider: ["dialog360", "meta", "resend"],
      outbound_message_status: ["queued", "sent", "delivered", "read", "failed"],
      outbound_related_type: ["appointment", "invoice", "agent", "manual"],
      patient_document_category: ["national_id", "insurance", "other"],
      payment_method: [
        "cash",
        "credit_card",
        "paypal",
        "bank_transfer",
        "insurance",
      ],
      registration_mode: ["invite_only", "open"],
      subscription_status: ["trialing", "active", "past_due", "cancelled"],
      template_approval_status: ["draft", "submitted", "approved", "rejected"],
      usage_metric: ["ai_messages", "wa_messages", "sms_messages", "emails"],
      user_role: ["admin", "receptionist", "manager", "doctor"],
    },
  },
} as const
