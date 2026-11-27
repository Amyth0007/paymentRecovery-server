ALTER TABLE "visitor_registrations" ADD COLUMN "checked_in_by" uuid;--> statement-breakpoint
ALTER TABLE "visitor_registrations" ADD COLUMN "checked_out_by" uuid;--> statement-breakpoint
ALTER TABLE "visitor_registrations" ADD CONSTRAINT "visitor_registrations_checked_in_by_users_id_fk" FOREIGN KEY ("checked_in_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_registrations" ADD CONSTRAINT "visitor_registrations_checked_out_by_users_id_fk" FOREIGN KEY ("checked_out_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
