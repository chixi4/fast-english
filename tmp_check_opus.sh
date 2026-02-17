TOKEN=sPcDsIZKmqmW5xLjIm2N2XXcRzPrTInTgBdaKkYe5gVw2Rjs
curl -sS -H "Authorization: Bearer ${TOKEN}" http://127.0.0.1:8317/v1/models | tr ',' '\n' | grep -Ei 'opus|claude'
