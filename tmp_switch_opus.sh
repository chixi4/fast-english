set -e

docker exec newapi-postgres psql -U newapi -d newapi -c "UPDATE channels SET models = replace(models, 'gemini-claude-opus-4-5-thinking', 'claude-opus-4-6-thinking') WHERE id=1;"

docker exec newapi-postgres psql -U newapi -d newapi -c "INSERT INTO abilities (\"group\", model, channel_id, enabled, priority, weight) SELECT \"group\", 'claude-opus-4-6-thinking', channel_id, enabled, priority, weight FROM abilities WHERE channel_id=1 AND model='gemini-claude-opus-4-5-thinking' AND NOT EXISTS (SELECT 1 FROM abilities a2 WHERE a2.channel_id=1 AND a2.\"group\"=abilities.\"group\" AND a2.model='claude-opus-4-6-thinking');"

docker exec newapi-postgres psql -U newapi -d newapi -c "DELETE FROM abilities WHERE channel_id=1 AND model='gemini-claude-opus-4-5-thinking';"

docker exec newapi-postgres psql -U newapi -d newapi -c "SELECT id,name,status,models FROM channels WHERE id=1;"

docker exec newapi-postgres psql -U newapi -d newapi -c "SELECT channel_id, \"group\", model, enabled, priority, weight FROM abilities WHERE model ILIKE '%opus%';"
