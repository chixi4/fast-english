set -e

docker exec newapi-postgres psql -U newapi -d newapi -tAc "SELECT value FROM options WHERE key='ModelRatio';" > /tmp/model_ratio.json
python3 - <<'PY'
import json
p='/tmp/model_ratio.json'
obj=json.loads(open(p,'r',encoding='utf-8').read().strip())
if 'claude-opus-4-6-thinking' not in obj:
    obj['claude-opus-4-6-thinking']=obj.get('gemini-claude-opus-4-5-thinking',1)
open('/tmp/model_ratio_new.json','w',encoding='utf-8').write(json.dumps(obj,ensure_ascii=False,separators=(',',':')))
print('SET_RATIO',obj['claude-opus-4-6-thinking'])
PY

VAL=$(cat /tmp/model_ratio_new.json)
docker exec newapi-postgres psql -U newapi -d newapi -c "UPDATE options SET value='${VAL}' WHERE key='ModelRatio';"

docker exec newapi-postgres psql -U newapi -d newapi -tAc "SELECT position('claude-opus-4-6-thinking' in value) FROM options WHERE key='ModelRatio';"
