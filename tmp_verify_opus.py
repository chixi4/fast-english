import requests
T='sPcDsIZKmqmW5xLjIm2N2XXcRzPrTInTgBdaKkYe5gVw2Rjs'
base='http://127.0.0.1:3000'
j=requests.get(base+'/v1/models',headers={'Authorization':'Bearer '+T},timeout=60).json()
ids=[x.get('id','') for x in j.get('data',[])]
print('HAS_OPUS46', 'claude-opus-4-6-thinking' in ids)
print('HAS_OLD_OPUS45', 'gemini-claude-opus-4-5-thinking' in ids)
r=requests.post(base+'/v1/responses',headers={'Authorization':'Bearer '+T,'Content-Type':'application/json'},json={'model':'claude-opus-4-6-thinking','input':'reply exactly: OPUS46_NEWAPI_OK'},timeout=120)
print('STATUS',r.status_code)
print(r.text[:900])
