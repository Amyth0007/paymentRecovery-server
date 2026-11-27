ALTER TABLE "visitor_registrations" ADD COLUMN "visitor_code" text;--> statement-breakpoint
UPDATE "visitor_registrations" SET "visitor_code" = replace(gen_random_uuid()::text, '-', '') WHERE "visitor_code" IS NULL;--> statement-breakpoint
ALTER TABLE "visitor_registrations" ALTER COLUMN "visitor_code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "visitor_registrations" ADD COLUMN "checked_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "visitor_registrations" ADD COLUMN "checked_out_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "visitor_registrations" ADD CONSTRAINT "visitor_registrations_visitorCode_unique" UNIQUE("visitor_code");
