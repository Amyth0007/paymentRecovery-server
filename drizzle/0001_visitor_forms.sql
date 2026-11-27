CREATE TABLE "visitor_forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visitor_passes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"form_version" integer NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visitor_passes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "visitor_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"pass_id" uuid,
	"form_id" uuid NOT NULL,
	"form_version" integer NOT NULL,
	"form_snapshot" jsonb NOT NULL,
	"values" jsonb NOT NULL,
	"channel" text DEFAULT 'public' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "visitor_forms" ADD CONSTRAINT "visitor_forms_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_forms" ADD CONSTRAINT "visitor_forms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_passes" ADD CONSTRAINT "visitor_passes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_passes" ADD CONSTRAINT "visitor_passes_form_id_visitor_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."visitor_forms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_passes" ADD CONSTRAINT "visitor_passes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_registrations" ADD CONSTRAINT "visitor_registrations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_registrations" ADD CONSTRAINT "visitor_registrations_pass_id_visitor_passes_id_fk" FOREIGN KEY ("pass_id") REFERENCES "public"."visitor_passes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_registrations" ADD CONSTRAINT "visitor_registrations_form_id_visitor_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."visitor_forms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "visitor_forms_organization_id_status_index" ON "visitor_forms" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "visitor_passes_organization_id_form_id_index" ON "visitor_passes" USING btree ("organization_id","form_id");--> statement-breakpoint
CREATE INDEX "visitor_registrations_organization_id_created_at_index" ON "visitor_registrations" USING btree ("organization_id","created_at");