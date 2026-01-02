import { GDX_SIGNAL_CODE } from '@/consts';

export const generateBashScript = (cmd: string = 'gdx'): string => {
   return `# gdx shell integration
${cmd}() {
    local tmp
    tmp="$(mktemp)"
    GDX_RESULT="$tmp" command gdx "$@"
    local ret=$?
    if [ $ret -eq ${GDX_SIGNAL_CODE} ]; then
        if [ -f "$tmp" ]; then
            cd "$(cat "$tmp")"
        fi
        rm -f "$tmp"
        return 0
    fi
    rm -f "$tmp"
    return $ret
}
`;
};

export const generateZshScript = (cmd: string = 'gdx'): string => {
   return generateBashScript(cmd);
};

export const generateFishScript = (cmd: string = 'gdx'): string => {
   return `# gdx shell integration
function ${cmd}
    set -l tmp (mktemp)
    set -x GDX_RESULT "$tmp"
    command gdx $argv
    set -l ret $status
    if test $ret -eq ${GDX_SIGNAL_CODE}
        if test -f "$tmp"
            cd (cat "$tmp")
        end
        rm -f "$tmp"
        return 0
    end
    rm -f "$tmp"
    return $ret
end
`;
};

export const generatePowershellScript = (cmd: string = 'gdx'): string => {
   return `# gdx shell integration
function ${cmd} {
    $tmp = [System.IO.Path]::GetTempFileName()
    $env:GDX_RESULT = $tmp
    try {
        $command = Get-Command -Name "gdx" -CommandType Application -ErrorAction SilentlyContinue
        if ($command.length -gt 1) {
            $command = $command | Select-Object -First 1
        }
        if ($command) {
            & $command @args
            if ($LASTEXITCODE -eq ${GDX_SIGNAL_CODE}) {
                if (Test-Path $tmp) {
                    $target = Get-Content $tmp -Raw
                    if ($target) {
                        Set-Location $target.Trim()
                    }
                }
            }
        } else {
            Write-Error "gdx executable not found"
        }
    } finally {
        if (Test-Path $tmp) {
            Remove-Item $tmp
        }
        $env:GDX_RESULT = $null
    }
}
`;
};

export const getShellScript = (shell: string, cmd?: string): string => {
   switch (shell.toLowerCase()) {
      case 'bash':
         return generateBashScript(cmd);
      case 'zsh':
         return generateZshScript(cmd);
      case 'fish':
         return generateFishScript(cmd);
      case 'powershell':
      case 'pwsh':
         return generatePowershellScript(cmd);
      default:
         throw new Error(`Unsupported shell: \${shell}\``);
   }
};
