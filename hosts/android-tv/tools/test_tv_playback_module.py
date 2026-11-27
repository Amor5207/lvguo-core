#!/usr/bin/env python3
"""Check that the bundled TV module matches its pinned key and rejects tampering."""
import base64,hashlib,json,pathlib,re,subprocess,tempfile
root=pathlib.Path(__file__).resolve().parents[1]
meta=json.loads((root/'assets/playback/module.json').read_text());dex=(root/'assets/playback/module.dex').read_bytes()
assert dex[:4]==b'dex\n' and meta['abi']==1
sha=hashlib.sha256(dex).hexdigest();assert sha==meta['sha256']
source=(root/'src/ink/pengfei/lvguo/net/TVPlaybackModule.java').read_text();public=base64.b64decode(re.search(r'private static final String PUB = "([^"]+)";',source).group(1))
msg=f"lvguo-tv-playback-module-v1\n{meta['revision']}\n{sha}\n{meta['url']}".encode()
with tempfile.TemporaryDirectory() as tmp:
 tmp=pathlib.Path(tmp);(tmp/'pub.der').write_bytes(public);(tmp/'signature').write_bytes(base64.b64decode(meta['signature']))
 subprocess.run(['openssl','pkey','-pubin','-inform','DER','-in',str(tmp/'pub.der'),'-out',str(tmp/'pub.pem')],check=True,stdout=subprocess.DEVNULL)
 command=['openssl','dgst','-sha256','-verify',str(tmp/'pub.pem'),'-signature',str(tmp/'signature')]
 assert subprocess.run(command,input=msg,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
 assert subprocess.run(command,input=msg+b'tamper',stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode!=0
print('TV bundled module hash, pinned signature and tampering rejection PASS')
