using System;
using System.IO;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using System.Runtime.InteropServices;
using System.Text;
class NativeLauncher {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
        public int cb; public string reserved,desktop,title; public int x,y,xSize,ySize,xChars,yChars,fill,flags;
        public short showWindow,reservedSize; public IntPtr reservedBytes,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public int processId,threadId; }
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,int mask,int flags);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,int flags,IntPtr environment,string directory,ref STARTUPINFO startup,out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll")] static extern int WaitForSingleObject(IntPtr handle,int timeout);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle,out int code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool WriteFile(IntPtr handle,byte[] bytes,int size,out int written,IntPtr overlapped);
    [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string name,uint access,uint share,ref SECURITY_ATTRIBUTES security,uint mode,uint flags,IntPtr template);
    static string Quote(string value) {
        if(value.IndexOf('"')>=0) throw new ArgumentException("Invalid quote in launch argument");
        int trailing=value.Length-value.TrimEnd('\\').Length;
        return "\""+value+new string('\\',trailing)+"\"";
    }
    static int Main(string[] args) {
        try {
            string runtime=AppDomain.CurrentDomain.BaseDirectory;
            var config=new JavaScriptSerializer().Deserialize<Dictionary<string,string>>(File.ReadAllText(Path.Combine(runtime,"current.json")));
            var command=new StringBuilder(Quote(config["PythonPath"])+" "+Quote(config["HostPath"]));
            foreach(string arg in args) command.Append(" "+Quote(arg));
            Environment.SetEnvironmentVariable("VIDSIFT_FFMPEG",config.ContainsKey("FfmpegPath") ? config["FfmpegPath"] : Path.Combine(runtime,"bin","ffmpeg.exe"));
            Environment.SetEnvironmentVariable("PYTHONIOENCODING","utf-8");
            var startup=new STARTUPINFO(); startup.cb=Marshal.SizeOf(startup); startup.flags=0x100;
            startup.input=GetStdHandle(-10); startup.output=GetStdHandle(-11); startup.error=GetStdHandle(-12);
            if(startup.input==IntPtr.Zero || startup.input==new IntPtr(-1) || !SetHandleInformation(startup.input,1,1)) throw new IOException("Missing inherited stdin handle");
            if(startup.output==IntPtr.Zero || startup.output==new IntPtr(-1) || !SetHandleInformation(startup.output,1,1)) throw new IOException("Missing inherited stdout handle");
            bool ownsError=false;
            if(startup.error==IntPtr.Zero || startup.error==new IntPtr(-1)) {
                var security=new SECURITY_ATTRIBUTES();security.length=Marshal.SizeOf(security);security.inherit=true;
                startup.error=CreateFile("NUL",0x40000000,3,ref security,3,0x80,IntPtr.Zero);ownsError=true;
                if(startup.error==new IntPtr(-1))throw new IOException("Cannot open native diagnostic sink");
            } else SetHandleInformation(startup.error,1,1);
            PROCESS_INFORMATION child;
            if(!CreateProcess(config["PythonPath"],command,IntPtr.Zero,IntPtr.Zero,true,0x08000000,IntPtr.Zero,runtime,ref startup,out child)) throw new IOException("CreateProcess failed: "+Marshal.GetLastWin32Error());
            try { WaitForSingleObject(child.process,-1); int code; if(!GetExitCodeProcess(child.process,out code)) return 1; return code; }
            finally { CloseHandle(child.thread); CloseHandle(child.process); if(ownsError)CloseHandle(startup.error); }
        } catch(Exception error) {
            try { File.AppendAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"native-launcher-errors.log"),DateTime.UtcNow.ToString("o")+" "+error.Message+"\n"); } catch {}
            byte[] bytes=Encoding.UTF8.GetBytes("VidSift native launcher: "+error.Message+"\n"); int written;
            WriteFile(GetStdHandle(-12),bytes,bytes.Length,out written,IntPtr.Zero); return 1;
        }
    }
}
