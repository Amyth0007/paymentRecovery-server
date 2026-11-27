ALTER TABLE "users" ADD COLUMN "denied_screens" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_roles" ADD COLUMN "denied_screens" text[] DEFAULT '{}'::text[] NOT NULL;
