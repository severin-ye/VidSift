"""Network-free host fixture: run a child while the protocol reader awaits input."""
import importlib.util
import sys
import time
from pathlib import Path

host_path, root, marker = sys.argv[1:]
spec = importlib.util.spec_from_file_location('fixture_native_host', host_path)
host = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = host
spec.loader.exec_module(host)
host.ROOT = Path(root)


def resolve(self, request, job, progress):
    # Let Host.run resume its blocking read on the still-open native input pipe.
    time.sleep(.25)
    code = 'from pathlib import Path;Path(' + repr(marker) + ').write_text("started");print("child completed")'
    output, _ = job.run([sys.executable, '-c', code], timeout=4)
    return {'output': output.strip()}


host.Service.resolve = resolve
sys.argv = [host_path, host.ORIGIN]
raise SystemExit(host.main())
