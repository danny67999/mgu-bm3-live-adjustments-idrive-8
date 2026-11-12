"""Audit the public source artifact, never a linked SDK package."""
from pathlib import Path, PurePosixPath
import hashlib,json,tarfile,sys
root=Path(__file__).resolve().parents[1]
package=json.loads((root/'template/package.json').read_text())
p=Path(sys.argv[1]) if len(sys.argv)>1 else root/'dist'/(package['name']+'@'+package['version']+'.tgz')
with tarfile.open(p) as archive:
    files=[m for m in archive.getmembers() if m.isfile()]
    names=[m.name for m in files]
    assert len(names)==len(set(names)), 'Duplicate archive paths'
    manifest=json.loads(archive.extractfile('mgu-app.json').read())
    for item in archive.getmembers():
        path=PurePosixPath(item.name)
        assert item.isfile() and not path.is_absolute() and '..' not in path.parts, item.name
        assert not {'javascript','node_modules','someipInterfaces'}.intersection(path.parts), item.name
        assert path.suffix not in {'.so','.node','.ncd','.pcap','.bin','.pem','.key'}, item.name
        data=archive.extractfile(item).read()
        assert not data.startswith(b'\x7fELF'), item.name
        assert b'PRIVATE KEY-----' not in data, item.name
    package=json.loads(archive.extractfile(manifest['tree']+'/package.json').read())
    assert manifest['id']==package['name'] and manifest['version']==package['version']
    assert manifest['mguHmi']==['ID8']
    assert package['main'] not in names and manifest['tree']+'/'+package['main'] not in names
    print(json.dumps({'archive':p.name,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),
        'files':len(files),'sdkBundled':False,'firmwareBundled':False,'id':manifest['id'],'version':manifest['version']},indent=2))
