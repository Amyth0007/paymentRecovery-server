ALTER TABLE "visitor_registrations" ADD COLUMN "checked_in_photo_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "visitor_registrations" ADD COLUMN "checked_out_photo_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "visitor_registrations" ADD CONSTRAINT "visitor_registrations_checked_in_photo_asset_id_file_assets_id_fk" FOREIGN KEY ("checked_in_photo_asset_id") REFERENCES "public"."file_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_registrations" ADD CONSTRAINT "visitor_registrations_checked_out_photo_asset_id_file_assets_id_fk" FOREIGN KEY ("checked_out_photo_asset_id") REFERENCES "public"."file_assets"("id") ON DELETE set null ON UPDATE no action;
