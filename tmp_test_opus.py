import requests, json
TOKEN='sPcDsIZKmqmW5xLjIm2N2XXcRzPrTInTgBdaKkYe5gVw2Rjs'
BASE='http://127.0.0.1:8317/v1/responses'
for m in ['gemini-claude-opus-4-5-thinking','gemini-claude-opus-4-6-thinking']:
    try:
        r=requests.post(BASE,headers={'Authorization':'Bearer '+TOKEN,'Content-Type':'application/json'},json={'model':m,'input':'reply exactly: '+m},timeout=90)
        print('MODEL',m,'STATUS',r.status_code)
        txt=r.text
        print(txt[:260].replace('\n',' '))
    except Exception as e:
        print('MODEL',m,'ERROR',e)
