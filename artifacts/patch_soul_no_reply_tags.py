from pathlib import Path
from datetime import datetime

p = Path('/opt/lobster-openclaw/workspace/SOUL.md')
backup = Path(f"{p}.bak-{datetime.now().strftime('%Y%m%d_%H%M%S')}")
backup.write_text(p.read_text(encoding='utf-8'), encoding='utf-8')

text = p.read_text(encoding='utf-8')
block = '''

## Output Directives

- In Control UI and webchat, never output machine directive tags in normal replies.
- Forbidden tags in user-facing text: [[reply_to_current]], [[reply_to:<id>]], [[audio_as_voice]].
- Use plain natural language only, unless the user explicitly asks to see raw tags.
'''

if '## Output Directives' not in text:
    text = text.rstrip() + block + '\n'
    p.write_text(text, encoding='utf-8')