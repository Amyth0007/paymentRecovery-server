CREATE SEQUENCE "organization_public_code_seq";--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "public_code" text;--> statement-breakpoint
WITH numbered AS (SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS n FROM "organizations") UPDATE "organizations" o SET "public_code" = 'Org' || numbered.n::text FROM numbered WHERE o."id" = numbered."id";--> statement-breakpoint
SELECT setval('organization_public_code_seq', COALESCE((SELECT MAX(substring("public_code" from 4)::bigint) FROM "organizations"), 1), EXISTS(SELECT 1 FROM "organizations"));--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "public_code" SET DEFAULT ('Org' || nextval('organization_public_code_seq')::text);--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "public_code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_public_code_unique" UNIQUE("public_code");
