-- Takes back 0157 (#1097). The field goes with its column; the version before
-- holds whether a draft follows its call by the marked line, as before.
ALTER TABLE "documents" DROP COLUMN "follows_call";
