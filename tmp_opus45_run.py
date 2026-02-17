import subprocess, requests, json, time

INPUT='/tmp/rust_input_source.txt'
OUTPUT='/tmp/opus45_output.md'
META='/tmp/opus45_meta.json'

raw=open(INPUT,'rb').read()
text=None
used=None
for enc in ['utf-8-sig','utf-8','gb18030','gbk']:
    try:
        text=raw.decode(enc)
        used=enc
        break
    except Exception:
        pass
if text is None:
    text=raw.decode('utf-8','ignore')
    used='utf-8-ignore'

key=subprocess.check_output("docker exec newapi-postgres psql -U newapi -d newapi -tAc \"SELECT key FROM channels WHERE id=1;\"",shell=True,universal_newlines=True).strip()
url='http://127.0.0.1:8317/v1/chat/completions'

messages=[{'role':'user','content':text}]
parts=[]
records=[]

for i in range(1,7):
    payload={
        'model':'gemini-claude-opus-4-5-thinking',
        'messages':messages,
        'max_tokens':64000,
        'stream':False
    }
    r=requests.post(url,headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'},json=payload,timeout=900)
    rec={'round':i,'status_code':r.status_code}
    if r.status_code!=200:
        rec['error_body']=r.text[:2000]
        records.append(rec)
        break
    j=r.json()
    choice=(j.get('choices') or [{}])[0]
    msg=choice.get('message') or {}
    content=msg.get('content','') or ''
    finish=choice.get('finish_reason')
    usage=j.get('usage') or {}
    rec['finish_reason']=finish
    rec['completion_tokens']=usage.get('completion_tokens')
    rec['prompt_tokens']=usage.get('prompt_tokens')
    rec['content_len']=len(content)
    records.append(rec)
    parts.append(content)
    messages.append({'role':'assistant','content':content})
    if finish!='max_tokens':
        break
    messages.append({'role':'user','content':'请从你上一段最后一句继续输出后续内容，不要重复前文，保持原有结构和语气。'})

full='\n\n'.join([p for p in parts if p])
open(OUTPUT,'w',encoding='utf-8').write(full)
meta={
    'input_encoding':used,
    'input_chars':len(text),
    'rounds':len(records),
    'records':records,
    'output_chars':len(full)
}
open(META,'w',encoding='utf-8').write(json.dumps(meta,ensure_ascii=False,indent=2))
print(json.dumps(meta,ensure_ascii=False))
