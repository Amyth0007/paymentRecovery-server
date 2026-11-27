CREATE TABLE "visitor_form_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"form_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"fields" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "visitor_passes" ADD COLUMN "version_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "visitor_form_versions" ADD CONSTRAINT "visitor_form_versions_form_id_visitor_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."visitor_forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "visitor_form_versions_form_id_version_index" ON "visitor_form_versions" USING btree ("form_id","version");--> statement-breakpoint
ALTER TABLE "visitor_passes" ADD CONSTRAINT "visitor_passes_version_id_visitor_form_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."visitor_form_versions"("id") ON DELETE no action ON UPDATE no action;