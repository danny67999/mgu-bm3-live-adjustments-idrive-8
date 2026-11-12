"""Generate the SDK-free repository-tree source from the public archive."""
from pathlib import Path,PurePosixPath
import tarfile,shutil,subprocess,json
R=Path(__file__).resolve().parents[1]
subprocess.run(['python3',str(R/'tools/audit-release.py')],check=True)
p=R/'dist/bm3_live_id8@0.1.0.tgz';d=R/'store/bm3_live_id8'
if d.exists():shutil.rmtree(d)
d.mkdir(parents=True)
with tarfile.open(p) as t:
 for m in t.getmembers():
  parts=PurePosixPath(m.name)
  if not m.isfile() or parts.is_absolute() or '..' in parts.parts:raise ValueError(m.name)
  dest=d.joinpath(*parts.parts);dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(t.extractfile(m).read())
release=json.loads((R/'release.json').read_text())
entry={'id':'bm3_live_id8','kind':'app','path':'store/bm3_live_id8','build':'unit','mguHmi':['ID8'],'requires':release['requires']}
(R/'mgu-repo.json').write_text(json.dumps({'schema':1,'components':[entry]},indent=2)+'\n')
