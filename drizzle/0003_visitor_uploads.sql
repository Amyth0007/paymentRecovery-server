CREATE TABLE "visitor_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"pass_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"file_asset_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "file_assets" ALTER COLUMN "uploaded_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "visitor_uploads" ADD CONSTRAINT "visitor_uploads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_uploads" ADD CONSTRAINT "visitor_uploads_pass_id_visitor_passes_id_fk" FOREIGN KEY ("pass_id") REFERENCES "public"."visitor_passes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_uploads" ADD CONSTRAINT "visitor_uploads_file_asset_id_file_assets_id_fk" FOREIGN KEY ("file_asset_id") REFERENCES "public"."file_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "visitor_uploads_pass_id_field_key_file_asset_id_index" ON "visitor_uploads" USING btree ("pass_id","field_key","file_asset_id");--> statement-breakpoint
CREATE INDEX "visitor_uploads_organization_id_pass_id_index" ON "visitor_uploads" USING btree ("organization_id","pass_id");