CREATE TABLE "attendance_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"workforce_employee_id" uuid,
	"attendance_date" text NOT NULL,
	"office_location_id" uuid,
	"check_in_location" jsonb,
	"check_out_location" jsonb,
	"status" text NOT NULL,
	"check_in_at" timestamp with time zone,
	"check_out_at" timestamp with time zone,
	"photo_asset_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"reason" text NOT NULL,
	"adjusted_by" uuid NOT NULL,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attendance_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"attendance_record_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"requested_check_in_at" timestamp with time zone,
	"requested_check_out_at" timestamp with time zone,
	"reason" text NOT NULL,
	"evidence_file_asset_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_comment" text DEFAULT '' NOT NULL,
	"applied_change" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attendance_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"expected_check_in" text DEFAULT '09:00' NOT NULL,
	"expected_check_out" text DEFAULT '17:00' NOT NULL,
	"grace_period_minutes" integer DEFAULT 10 NOT NULL,
	"half_day_hours" double precision DEFAULT 4 NOT NULL,
	"gps_accuracy_threshold_m" double precision DEFAULT 50 NOT NULL,
	"location_verification_required" boolean DEFAULT true NOT NULL,
	"weekly_holidays" integer[] DEFAULT '{0}'::integer[] NOT NULL,
	"correction_requests_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_policies_organizationId_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
CREATE TABLE "attendance_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"attendance_date" text NOT NULL,
	"office_location_id" uuid,
	"shift_id" uuid,
	"shift_name" text,
	"check_in" jsonb,
	"check_out" jsonb,
	"status" text DEFAULT 'checked_in' NOT NULL,
	"late_arrival" boolean DEFAULT false NOT NULL,
	"total_working_minutes" integer,
	"unpaid_break_minutes" integer DEFAULT 0 NOT NULL,
	"corrected_check_out_at" timestamp with time zone,
	"correction_id" uuid,
	"half_day" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"actor_id" uuid NOT NULL,
	"actor_role" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commitments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"invoice_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"promised_amount_minor" bigint NOT NULL,
	"promised_date" text NOT NULL,
	"delay_reason" text DEFAULT '' NOT NULL,
	"responsible_person" text NOT NULL,
	"recorded_by" uuid NOT NULL,
	"file_asset_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"source_visit_id" uuid,
	"status" text DEFAULT 'upcoming' NOT NULL,
	"fulfilled_amount_minor" bigint DEFAULT 0 NOT NULL,
	"evaluated_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compensation_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"structure_id" uuid NOT NULL,
	"effective_from" text NOT NULL,
	"effective_to" text,
	"assigned_by" uuid NOT NULL,
	"rate_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compensation_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"calculation" text NOT NULL,
	"amount_minor" bigint DEFAULT 0 NOT NULL,
	"rate_basis_points" integer DEFAULT 0 NOT NULL,
	"basis_component_code" text DEFAULT '' NOT NULL,
	"effective_from" text NOT NULL,
	"effective_to" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_rule_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"jurisdiction" text NOT NULL,
	"region_code" text DEFAULT '' NOT NULL,
	"industry" text NOT NULL,
	"employee_category" text NOT NULL,
	"rule_code" text NOT NULL,
	"parameters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"effective_from" text NOT NULL,
	"effective_to" text,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" uuid NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"legal_review_reference" text DEFAULT '' NOT NULL,
	"activation_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"module_permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"action_permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"company_name" text DEFAULT '' NOT NULL,
	"gstin" text,
	"email" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"contacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"billing_address" jsonb DEFAULT '{"line1":"","line2":"","city":"","state":"","postalCode":"","country":"India"}'::jsonb NOT NULL,
	"business_address" jsonb DEFAULT '{"line1":"","line2":"","city":"","state":"","postalCode":"","country":"India"}'::jsonb NOT NULL,
	"default_credit_days" integer DEFAULT 30 NOT NULL,
	"credit_limit_minor" bigint,
	"notes" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_earnings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"earning_date" text NOT NULL,
	"source" text NOT NULL,
	"description" text NOT NULL,
	"quantity_thousandths" bigint NOT NULL,
	"rate_minor" bigint NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_by" uuid NOT NULL,
	"adjustment_of" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text DEFAULT '' NOT NULL,
	"manager_employee_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "designations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"original_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"storage_path" text DEFAULT '' NOT NULL,
	"storage_url" text,
	"cloudinary_public_id" text,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gmail_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connected_by_user_id" uuid NOT NULL,
	"provider" text DEFAULT 'google' NOT NULL,
	"google_account_id" text NOT NULL,
	"email" text NOT NULL,
	"encrypted_refresh_token" text NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"connected_at" timestamp with time zone NOT NULL,
	"last_successful_email_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gmail_connections_organizationId_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
CREATE TABLE "gmail_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"invoice_id" uuid,
	"sender_email" text NOT NULL,
	"recipient_email" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"gmail_message_id" text,
	"status" text NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gmail_oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state_hash" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gmail_oauth_states_stateHash_unique" UNIQUE("state_hash")
);
--> statement-breakpoint
CREATE TABLE "invoice_acknowledgements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"status" text NOT NULL,
	"event_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responsible_person_name" text DEFAULT '' NOT NULL,
	"responsible_person_designation" text DEFAULT '' NOT NULL,
	"remarks" text DEFAULT '' NOT NULL,
	"file_asset_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"recorded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"invoice_number" text NOT NULL,
	"invoice_date" text NOT NULL,
	"due_date" text NOT NULL,
	"credit_days" integer,
	"term_source" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"outstanding_minor" bigint DEFAULT 0 NOT NULL,
	"document_status" text DEFAULT 'draft' NOT NULL,
	"acknowledgement_status" text DEFAULT 'not_shared' NOT NULL,
	"party_snapshot" jsonb,
	"notes" text DEFAULT '' NOT NULL,
	"cancellation" jsonb,
	"issued_at" timestamp with time zone,
	"issued_by" uuid,
	"primary_file_asset_id" uuid,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"entitlement_days" double precision NOT NULL,
	"used_days" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"start_date" text NOT NULL,
	"end_date" text NOT NULL,
	"days" double precision NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_comment" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"paid" boolean DEFAULT true NOT NULL,
	"annual_entitlement_days" double precision DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"bucket" text DEFAULT 'principal' NOT NULL,
	"type" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"payment_id" uuid,
	"effective_date" text NOT NULL,
	"recorded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "office_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address" text NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"geofence_radius_m" double precision NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" text NOT NULL,
	"started_on" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_subscriptions_organizationId_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"legal_name" text DEFAULT '' NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"gstin" text,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"show_guides" boolean DEFAULT true NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"settings" jsonb DEFAULT '{"acknowledgementEvidenceRequired":false,"pauseRemindersWhenDisputed":false,"reminderSendHourLocal":9,"commitmentGraceDays":0,"fieldLocationCapture":"off","autoFollowUpOnMissedCommitment":true}'::jsonb NOT NULL,
	"modules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "overtime_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"work_date" text NOT NULL,
	"actual_minutes" integer NOT NULL,
	"calculated_minutes" integer NOT NULL,
	"approved_minutes" integer DEFAULT 0 NOT NULL,
	"policy_id" uuid NOT NULL,
	"policy_snapshot" jsonb NOT NULL,
	"hourly_rate_minor" bigint NOT NULL,
	"payable_amount_minor" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "overtime_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"calculation" text NOT NULL,
	"multiplier_basis_points" integer DEFAULT 15000 NOT NULL,
	"hourly_rate_minor" bigint DEFAULT 0 NOT NULL,
	"minimum_minutes" integer DEFAULT 1 NOT NULL,
	"rounding_minutes" integer DEFAULT 1 NOT NULL,
	"maximum_minutes_per_day" integer DEFAULT 240 NOT NULL,
	"effective_from" text NOT NULL,
	"effective_to" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pay_structures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mode" text NOT NULL,
	"pay_basis" text NOT NULL,
	"base_rate_minor" bigint NOT NULL,
	"components" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"effective_from" text NOT NULL,
	"effective_to" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"invoice_id" uuid NOT NULL,
	"bucket" text DEFAULT 'principal' NOT NULL,
	"amount_minor" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" text DEFAULT 'collection' NOT NULL,
	"reverses_payment_id" uuid,
	"payment_reference" text NOT NULL,
	"payment_date" text NOT NULL,
	"mode" text DEFAULT 'bank_transfer' NOT NULL,
	"transaction_reference" text DEFAULT '' NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"file_asset_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"remarks" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'posted' NOT NULL,
	"idempotency_key" text NOT NULL,
	"reversed_at" timestamp with time zone,
	"recorded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_run_employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"employee_id" uuid NOT NULL,
	"employee_number" text NOT NULL,
	"employee_name" text NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"department_name" text DEFAULT '' NOT NULL,
	"designation_name" text DEFAULT '' NOT NULL,
	"joining_date" text DEFAULT '' NOT NULL,
	"currency" text NOT NULL,
	"daily_rate_minor" bigint,
	"scheduled_work_days" double precision,
	"structure_snapshot" jsonb NOT NULL,
	"attendance_days" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"gross_earnings_minor" bigint NOT NULL,
	"deductions_minor" bigint NOT NULL,
	"employer_contributions_minor" bigint NOT NULL,
	"net_pay_minor" bigint NOT NULL,
	"paid_minor" bigint DEFAULT 0 NOT NULL,
	"payment_reference" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_run_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"employee_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"reference" text DEFAULT '' NOT NULL,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text DEFAULT 'Payroll' NOT NULL,
	"period_key" text NOT NULL,
	"period_start" text NOT NULL,
	"period_end" text NOT NULL,
	"currency" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"totals" jsonb DEFAULT '{"employees":0,"grossEarningsMinor":0,"deductionsMinor":0,"employerContributionsMinor":0,"netPayMinor":0}'::jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"finalized_by" uuid,
	"finalized_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"revision_of" uuid,
	"revision_reason" text DEFAULT '' NOT NULL,
	"reversed_by" uuid,
	"reversed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"invoice_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"outstanding_snapshot_minor" bigint NOT NULL,
	"assignee_id" uuid NOT NULL,
	"assigned_by" uuid NOT NULL,
	"assigned_on" text NOT NULL,
	"visit_deadline" text NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'assigned' NOT NULL,
	"close_reason" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_call_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"invoice_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"employee_id" uuid NOT NULL,
	"visited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"contact_person_name" text NOT NULL,
	"contact_designation" text DEFAULT '' NOT NULL,
	"outcome" text NOT NULL,
	"discussion" text NOT NULL,
	"non_payment_reason" text DEFAULT '' NOT NULL,
	"promised_date" text,
	"promised_amount_minor" bigint,
	"commitment_id" uuid,
	"file_asset_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"location" jsonb,
	"remarks" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"family_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by_token_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "workforce_shift_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"effective_from" text NOT NULL,
	"effective_to" text,
	"assigned_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workforce_shift_swaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"requester_employee_id" uuid NOT NULL,
	"target_employee_id" uuid NOT NULL,
	"requester_shift_id" uuid,
	"target_shift_id" uuid,
	"shift_date" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_comment" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workforce_shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"shift_type" text NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"crosses_midnight" boolean DEFAULT false NOT NULL,
	"flexible_window_minutes" integer DEFAULT 0 NOT NULL,
	"breaks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"weekly_offs" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"effective_from" text NOT NULL,
	"effective_to" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_plans_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text NOT NULL,
	"module_permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"module_permissions_configured" boolean DEFAULT false NOT NULL,
	"action_permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"custom_role_id" uuid,
	"workforce_scope" jsonb DEFAULT '{"mode":"organization","departmentIds":[],"locationIds":[]}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"token_version" integer DEFAULT 0 NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "workforce_employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"employee_number" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"date_of_birth" text,
	"joining_date" text NOT NULL,
	"employment_type" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"department_id" uuid,
	"designation_id" uuid,
	"reporting_manager_id" uuid,
	"work_location_id" uuid,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance_adjustments" ADD CONSTRAINT "attendance_adjustments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_adjustments" ADD CONSTRAINT "attendance_adjustments_workforce_employee_id_workforce_employees_id_fk" FOREIGN KEY ("workforce_employee_id") REFERENCES "public"."workforce_employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_adjustments" ADD CONSTRAINT "attendance_adjustments_office_location_id_office_locations_id_fk" FOREIGN KEY ("office_location_id") REFERENCES "public"."office_locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_adjustments" ADD CONSTRAINT "attendance_adjustments_adjusted_by_users_id_fk" FOREIGN KEY ("adjusted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_attendance_record_id_attendance_records_id_fk" FOREIGN KEY ("attendance_record_id") REFERENCES "public"."attendance_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_evidence_file_asset_id_file_assets_id_fk" FOREIGN KEY ("evidence_file_asset_id") REFERENCES "public"."file_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_policies" ADD CONSTRAINT "attendance_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_office_location_id_office_locations_id_fk" FOREIGN KEY ("office_location_id") REFERENCES "public"."office_locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_shift_id_workforce_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."workforce_shifts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_correction_id_attendance_corrections_id_fk" FOREIGN KEY ("correction_id") REFERENCES "public"."attendance_corrections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_source_visit_id_recovery_visits_id_fk" FOREIGN KEY ("source_visit_id") REFERENCES "public"."recovery_visits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_assignments" ADD CONSTRAINT "compensation_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_assignments" ADD CONSTRAINT "compensation_assignments_employee_id_workforce_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."workforce_employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_assignments" ADD CONSTRAINT "compensation_assignments_structure_id_pay_structures_id_fk" FOREIGN KEY ("structure_id") REFERENCES "public"."pay_structures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_assignments" ADD CONSTRAINT "compensation_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_components" ADD CONSTRAINT "compensation_components_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_rule_sets" ADD CONSTRAINT "compliance_rule_sets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_rule_sets" ADD CONSTRAINT "compliance_rule_sets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_rule_sets" ADD CONSTRAINT "compliance_rule_sets_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_roles" ADD CONSTRAINT "custom_roles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_roles" ADD CONSTRAINT "custom_roles_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_roles" ADD CONSTRAINT "custom_roles_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_earnings" ADD CONSTRAINT "daily_earnings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_earnings" ADD CONSTRAINT "daily_earnings_employee_id_workforce_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."workforce_employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_earnings" ADD CONSTRAINT "daily_earnings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_earnings" ADD CONSTRAINT "daily_earnings_adjustment_of_daily_earnings_id_fk" FOREIGN KEY ("adjustment_of") REFERENCES "public"."daily_earnings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_manager_employee_id_workforce_employees_id_fk" FOREIGN KEY ("manager_employee_id") REFERENCES "public"."workforce_employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "designations" ADD CONSTRAINT "designations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_connections" ADD CONSTRAINT "gmail_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_connections" ADD CONSTRAINT "gmail_connections_connected_by_user_id_users_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_emails" ADD CONSTRAINT "gmail_emails_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_emails" ADD CONSTRAINT "gmail_emails_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_emails" ADD CONSTRAINT "gmail_emails_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_emails" ADD CONSTRAINT "gmail_emails_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_oauth_states" ADD CONSTRAINT "gmail_oauth_states_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_oauth_states" ADD CONSTRAINT "gmail_oauth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_acknowledgements" ADD CONSTRAINT "invoice_acknowledgements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_acknowledgements" ADD CONSTRAINT "invoice_acknowledgements_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_acknowledgements" ADD CONSTRAINT "invoice_acknowledgements_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_primary_file_asset_id_file_assets_id_fk" FOREIGN KEY ("primary_file_asset_id") REFERENCES "public"."file_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_employee_id_workforce_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."workforce_employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_leave_type_id_leave_types_id_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."leave_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_employee_id_workforce_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."workforce_employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_leave_type_id_leave_types_id_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."leave_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "office_locations" ADD CONSTRAINT "office_locations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_subscriptions" ADD CONSTRAINT "organization_subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_subscriptions" ADD CONSTRAINT "organization_subscriptions_plan_id_subscription_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime_entries" ADD CONSTRAINT "overtime_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime_entries" ADD CONSTRAINT "overtime_entries_employee_id_workforce_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."workforce_employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime_entries" ADD CONSTRAINT "overtime_entries_policy_id_overtime_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."overtime_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime_entries" ADD CONSTRAINT "overtime_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime_entries" ADD CONSTRAINT "overtime_entries_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime_policies" ADD CONSTRAINT "overtime_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_structures" ADD CONSTRAINT "pay_structures_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_reverses_payment_id_payments_id_fk" FOREIGN KEY ("reverses_payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_run_employees" ADD CONSTRAINT "payroll_run_employees_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_run_employees" ADD CONSTRAINT "payroll_run_employees_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_run_payments" ADD CONSTRAINT "payroll_run_payments_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_run_payments" ADD CONSTRAINT "payroll_run_payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_run_payments" ADD CONSTRAINT "payroll_run_payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_finalized_by_users_id_fk" FOREIGN KEY ("finalized_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_revision_of_payroll_runs_id_fk" FOREIGN KEY ("revision_of") REFERENCES "public"."payroll_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_reversed_by_payroll_runs_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."payroll_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_assignments" ADD CONSTRAINT "recovery_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_assignments" ADD CONSTRAINT "recovery_assignments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_assignments" ADD CONSTRAINT "recovery_assignments_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_assignments" ADD CONSTRAINT "recovery_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_call_attempts" ADD CONSTRAINT "recovery_call_attempts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_call_attempts" ADD CONSTRAINT "recovery_call_attempts_assignment_id_recovery_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."recovery_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_call_attempts" ADD CONSTRAINT "recovery_call_attempts_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_call_attempts" ADD CONSTRAINT "recovery_call_attempts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_call_attempts" ADD CONSTRAINT "recovery_call_attempts_employee_id_users_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_visits" ADD CONSTRAINT "recovery_visits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_visits" ADD CONSTRAINT "recovery_visits_assignment_id_recovery_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."recovery_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_visits" ADD CONSTRAINT "recovery_visits_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_visits" ADD CONSTRAINT "recovery_visits_employee_id_users_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_visits" ADD CONSTRAINT "recovery_visits_commitment_id_commitments_id_fk" FOREIGN KEY ("commitment_id") REFERENCES "public"."commitments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_shift_assignments" ADD CONSTRAINT "workforce_shift_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_shift_assignments" ADD CONSTRAINT "workforce_shift_assignments_employee_id_workforce_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."workforce_employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_shift_assignments" ADD CONSTRAINT "workforce_shift_assignments_shift_id_workforce_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."workforce_shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_shift_assignments" ADD CONSTRAINT "workforce_shift_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_shift_swaps" ADD CONSTRAINT "workforce_shift_swaps_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_shift_swaps" ADD CONSTRAINT "workforce_shift_swaps_requester_employee_id_workforce_employees_id_fk" FOREIGN KEY ("requester_employee_id") REFERENCES "public"."workforce_employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_shift_swaps" ADD CONSTRAINT "workforce_shift_swaps_target_employee_id_workforce_employees_id_fk" FOREIGN KEY ("target_employee_id") REFERENCES "public"."workforce_employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_shift_swaps" ADD CONSTRAINT "workforce_shift_swaps_requester_shift_id_workforce_shifts_id_fk" FOREIGN KEY ("requester_shift_id") REFERENCES "public"."workforce_shifts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_shift_swaps" ADD CONSTRAINT "workforce_shift_swaps_target_shift_id_workforce_shifts_id_fk" FOREIGN KEY ("target_shift_id") REFERENCES "public"."workforce_shifts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_shift_swaps" ADD CONSTRAINT "workforce_shift_swaps_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_shifts" ADD CONSTRAINT "workforce_shifts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_custom_role_id_custom_roles_id_fk" FOREIGN KEY ("custom_role_id") REFERENCES "public"."custom_roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_employees" ADD CONSTRAINT "workforce_employees_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_employees" ADD CONSTRAINT "workforce_employees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_employees" ADD CONSTRAINT "workforce_employees_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_employees" ADD CONSTRAINT "workforce_employees_designation_id_designations_id_fk" FOREIGN KEY ("designation_id") REFERENCES "public"."designations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_employees" ADD CONSTRAINT "workforce_employees_reporting_manager_id_workforce_employees_id_fk" FOREIGN KEY ("reporting_manager_id") REFERENCES "public"."workforce_employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workforce_employees" ADD CONSTRAINT "workforce_employees_work_location_id_office_locations_id_fk" FOREIGN KEY ("work_location_id") REFERENCES "public"."office_locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_adjustments_organization_id_employee_id_attendance_date_index" ON "attendance_adjustments" USING btree ("organization_id","employee_id","attendance_date");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_adjustments_organization_id_workforce_employee_id_attendance_date_index" ON "attendance_adjustments" USING btree ("organization_id","workforce_employee_id","attendance_date") WHERE "attendance_adjustments"."workforce_employee_id" is not null;--> statement-breakpoint
CREATE INDEX "attendance_adjustments_organization_id_attendance_date_index" ON "attendance_adjustments" USING btree ("organization_id","attendance_date");--> statement-breakpoint
CREATE INDEX "attendance_corrections_organization_id_employee_id_created_at_index" ON "attendance_corrections" USING btree ("organization_id","employee_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "attendance_corrections_organization_id_status_created_at_index" ON "attendance_corrections" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_records_organization_id_employee_id_attendance_date_index" ON "attendance_records" USING btree ("organization_id","employee_id","attendance_date");--> statement-breakpoint
CREATE INDEX "attendance_records_organization_id_attendance_date_status_index" ON "attendance_records" USING btree ("organization_id","attendance_date","status");--> statement-breakpoint
CREATE INDEX "audit_logs_organization_id_created_at_index" ON "audit_logs" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_entity_type_entity_id_index" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "commitments_organization_id_status_promised_date_index" ON "commitments" USING btree ("organization_id","status","promised_date");--> statement-breakpoint
CREATE INDEX "commitments_organization_id_customer_id_index" ON "commitments" USING btree ("organization_id","customer_id");--> statement-breakpoint
CREATE INDEX "commitments_invoice_ids_index" ON "commitments" USING gin ("invoice_ids");--> statement-breakpoint
CREATE UNIQUE INDEX "compensation_assignments_organization_id_employee_id_effective_from_index" ON "compensation_assignments" USING btree ("organization_id","employee_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "compensation_components_organization_id_code_effective_from_index" ON "compensation_components" USING btree ("organization_id","code","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "compliance_rule_sets_organization_id_rule_code_jurisdiction_region_code_effective_from_version_index" ON "compliance_rule_sets" USING btree ("organization_id","rule_code","jurisdiction","region_code","effective_from","version");--> statement-breakpoint
CREATE INDEX "compliance_rule_sets_organization_id_status_rule_code_effective_from_index" ON "compliance_rule_sets" USING btree ("organization_id","status","rule_code","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_roles_organization_id_name_index" ON "custom_roles" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "custom_roles_organization_id_status_index" ON "custom_roles" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "customers_organization_id_status_display_name_index" ON "customers" USING btree ("organization_id","status","display_name");--> statement-breakpoint
CREATE INDEX "customers_organization_id_company_name_index" ON "customers" USING btree ("organization_id","company_name");--> statement-breakpoint
CREATE INDEX "daily_earnings_organization_id_employee_id_earning_date_status_index" ON "daily_earnings" USING btree ("organization_id","employee_id","earning_date","status");--> statement-breakpoint
CREATE UNIQUE INDEX "departments_organization_id_name_index" ON "departments" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "departments_organization_id_status_index" ON "departments" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "designations_organization_id_name_index" ON "designations" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "designations_organization_id_status_index" ON "designations" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "file_assets_organization_id_purpose_index" ON "file_assets" USING btree ("organization_id","purpose");--> statement-breakpoint
CREATE INDEX "gmail_emails_organization_id_created_at_index" ON "gmail_emails" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "gmail_emails_organization_id_invoice_id_created_at_index" ON "gmail_emails" USING btree ("organization_id","invoice_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "gmail_oauth_states_expires_at_index" ON "gmail_oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "invoice_acknowledgements_organization_id_invoice_id_created_at_index" ON "invoice_acknowledgements" USING btree ("organization_id","invoice_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_organization_id_invoice_number_index" ON "invoices" USING btree ("organization_id","invoice_number");--> statement-breakpoint
CREATE INDEX "invoices_organization_id_customer_id_document_status_index" ON "invoices" USING btree ("organization_id","customer_id","document_status");--> statement-breakpoint
CREATE INDEX "invoices_organization_id_due_date_document_status_index" ON "invoices" USING btree ("organization_id","due_date","document_status");--> statement-breakpoint
CREATE INDEX "invoices_organization_id_document_status_outstanding_minor_index" ON "invoices" USING btree ("organization_id","document_status","outstanding_minor");--> statement-breakpoint
CREATE UNIQUE INDEX "leave_balances_organization_id_employee_id_leave_type_id_year_index" ON "leave_balances" USING btree ("organization_id","employee_id","leave_type_id","year");--> statement-breakpoint
CREATE INDEX "leave_requests_organization_id_employee_id_start_date_end_date_status_index" ON "leave_requests" USING btree ("organization_id","employee_id","start_date","end_date","status");--> statement-breakpoint
CREATE INDEX "leave_requests_organization_id_status_start_date_index" ON "leave_requests" USING btree ("organization_id","status","start_date");--> statement-breakpoint
CREATE UNIQUE INDEX "leave_types_organization_id_code_index" ON "leave_types" USING btree ("organization_id","code");--> statement-breakpoint
CREATE INDEX "ledger_entries_organization_id_invoice_id_created_at_index" ON "ledger_entries" USING btree ("organization_id","invoice_id","created_at");--> statement-breakpoint
CREATE INDEX "ledger_entries_organization_id_customer_id_effective_date_index" ON "ledger_entries" USING btree ("organization_id","customer_id","effective_date");--> statement-breakpoint
CREATE INDEX "ledger_entries_payment_id_index" ON "ledger_entries" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "office_locations_organization_id_status_name_index" ON "office_locations" USING btree ("organization_id","status","name");--> statement-breakpoint
CREATE INDEX "organizations_status_name_index" ON "organizations" USING btree ("status","name");--> statement-breakpoint
CREATE INDEX "overtime_entries_organization_id_employee_id_work_date_index" ON "overtime_entries" USING btree ("organization_id","employee_id","work_date");--> statement-breakpoint
CREATE INDEX "overtime_entries_organization_id_status_work_date_index" ON "overtime_entries" USING btree ("organization_id","status","work_date");--> statement-breakpoint
CREATE UNIQUE INDEX "overtime_policies_organization_id_name_effective_from_index" ON "overtime_policies" USING btree ("organization_id","name","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "pay_structures_organization_id_name_effective_from_index" ON "pay_structures" USING btree ("organization_id","name","effective_from");--> statement-breakpoint
CREATE INDEX "payment_allocations_payment_id_position_index" ON "payment_allocations" USING btree ("payment_id","position");--> statement-breakpoint
CREATE INDEX "payment_allocations_organization_id_invoice_id_index" ON "payment_allocations" USING btree ("organization_id","invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_organization_id_idempotency_key_index" ON "payments" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "payments_organization_id_customer_id_payment_date_index" ON "payments" USING btree ("organization_id","customer_id","payment_date");--> statement-breakpoint
CREATE INDEX "payroll_run_employees_run_id_position_index" ON "payroll_run_employees" USING btree ("run_id","position");--> statement-breakpoint
CREATE INDEX "payroll_run_employees_organization_id_employee_id_index" ON "payroll_run_employees" USING btree ("organization_id","employee_id");--> statement-breakpoint
CREATE INDEX "payroll_run_payments_run_id_position_index" ON "payroll_run_payments" USING btree ("run_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_runs_organization_id_period_key_revision_index" ON "payroll_runs" USING btree ("organization_id","period_key","revision");--> statement-breakpoint
CREATE INDEX "payroll_runs_organization_id_state_period_start_index" ON "payroll_runs" USING btree ("organization_id","state","period_start" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "recovery_assignments_organization_id_assignee_id_status_index" ON "recovery_assignments" USING btree ("organization_id","assignee_id","status");--> statement-breakpoint
CREATE INDEX "recovery_assignments_organization_id_customer_id_index" ON "recovery_assignments" USING btree ("organization_id","customer_id");--> statement-breakpoint
CREATE INDEX "recovery_assignments_organization_id_status_index" ON "recovery_assignments" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "recovery_assignments_invoice_ids_index" ON "recovery_assignments" USING gin ("invoice_ids");--> statement-breakpoint
CREATE INDEX "recovery_call_attempts_organization_id_assignment_id_invoice_id_attempted_at_index" ON "recovery_call_attempts" USING btree ("organization_id","assignment_id","invoice_id","attempted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "recovery_visits_organization_id_assignment_id_created_at_index" ON "recovery_visits" USING btree ("organization_id","assignment_id","created_at");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_id_index" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_id_index" ON "refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workforce_shift_assignments_organization_id_employee_id_effective_from_index" ON "workforce_shift_assignments" USING btree ("organization_id","employee_id","effective_from");--> statement-breakpoint
CREATE INDEX "workforce_shift_assignments_organization_id_shift_id_effective_from_index" ON "workforce_shift_assignments" USING btree ("organization_id","shift_id","effective_from");--> statement-breakpoint
CREATE INDEX "workforce_shift_swaps_organization_id_shift_date_status_index" ON "workforce_shift_swaps" USING btree ("organization_id","shift_date","status");--> statement-breakpoint
CREATE INDEX "workforce_shift_swaps_organization_id_requester_employee_id_shift_date_index" ON "workforce_shift_swaps" USING btree ("organization_id","requester_employee_id","shift_date");--> statement-breakpoint
CREATE INDEX "workforce_shift_swaps_organization_id_target_employee_id_shift_date_index" ON "workforce_shift_swaps" USING btree ("organization_id","target_employee_id","shift_date");--> statement-breakpoint
CREATE UNIQUE INDEX "workforce_shifts_organization_id_name_effective_from_index" ON "workforce_shifts" USING btree ("organization_id","name","effective_from");--> statement-breakpoint
CREATE INDEX "workforce_shifts_organization_id_status_effective_from_index" ON "workforce_shifts" USING btree ("organization_id","status","effective_from");--> statement-breakpoint
CREATE INDEX "users_organization_id_status_index" ON "users" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "users_organization_id_custom_role_id_status_index" ON "users" USING btree ("organization_id","custom_role_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "workforce_employees_organization_id_employee_number_index" ON "workforce_employees" USING btree ("organization_id","employee_number");--> statement-breakpoint
CREATE UNIQUE INDEX "workforce_employees_organization_id_user_id_index" ON "workforce_employees" USING btree ("organization_id","user_id") WHERE "workforce_employees"."user_id" is not null;--> statement-breakpoint
CREATE INDEX "workforce_employees_organization_id_status_department_id_last_name_first_name_index" ON "workforce_employees" USING btree ("organization_id","status","department_id","last_name","first_name");--> statement-breakpoint
CREATE INDEX "workforce_employees_organization_id_email_index" ON "workforce_employees" USING btree ("organization_id","email");