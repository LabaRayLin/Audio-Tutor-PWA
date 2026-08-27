$port = 8765
$logFile = Join-Path $PSScriptRoot "debug.log"
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$port/")

try {
    $listener.Start()
    Write-Output "OK: Audio Tutor Local Log Receiver listening on http://127.0.0.1:$port/ -> $logFile"
    
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response
        
        $response.AddHeader("Access-Control-Allow-Origin", "*")
        $response.AddHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        $response.AddHeader("Access-Control-Allow-Headers", "*")
        
        if ($request.HttpMethod -eq "OPTIONS") {
            $response.StatusCode = 200
            $response.Close()
            continue
        }
        
        if ($request.HttpMethod -eq "POST") {
            $reader = New-Object System.IO.StreamReader($request.InputStream, [System.Text.Encoding]::UTF8)
            $body = $reader.ReadToEnd()
            $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
            $entry = "[$timestamp] $body`r`n"
            [System.IO.File]::AppendAllText($logFile, $entry, [System.Text.Encoding]::UTF8)
        }
        
        $response.StatusCode = 200
        $buffer = [System.Text.Encoding]::UTF8.GetBytes("OK")
        $response.ContentLength64 = $buffer.Length
        $response.OutputStream.Write($buffer, 0, $buffer.Length)
        $response.Close()
    }
} catch {
    Write-Error "Listener error: $_"
} finally {
    $listener.Stop()
}
