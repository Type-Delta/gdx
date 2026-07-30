import litedent from 'litedent';

import { GDX_SIGNAL_CODE } from '@/consts';

export const generateBashScript = (cmd: string = 'gdx'): string => {
   return litedent`
   # gdx shell integration
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

   # Completion function for ${cmd}
   __gdx_complete_bash() {
      local cur prev words cword
      _init_completion || return

      # Build args array excluding command name
      local args=("\${words[@]:1}")
      local idx=$((cword - 1))

      # Call gdx completion
      local out
      out="$(GDX_CMP_IDX="$idx" command gdx __completion "\${args[@]}" 2>/dev/null)"

      if [ -n "$out" ]; then
         # Use gdx suggestions
         COMPREPLY=( $(compgen -W "$out" -- "$cur") )
         return 0
      fi

      # Fallback to git completion
      if declare -F _git >/dev/null 2>&1; then
         # Temporarily set words[0] to git for git completion
         local orig_word0="\${words[0]}"
         words[0]="git"
         _git
         words[0]="$orig_word0"
      elif [ -f /usr/share/bash-completion/completions/git ]; then
         source /usr/share/bash-completion/completions/git 2>/dev/null
         if declare -F _git >/dev/null 2>&1; then
            local orig_word0="\${words[0]}"
            words[0]="git"
            _git
            words[0]="$orig_word0"
         fi
      fi
   }

   complete -o bashdefault -o default -F __gdx_complete_bash ${cmd}
   `;
};

export const generateZshScript = (cmd: string = 'gdx'): string => {
   return litedent`
   # gdx shell integration
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

   # Completion function for ${cmd}
   __gdx_complete_zsh() {
      local -a args
      local idx

      # Build args from words, excluding command name
      args=("\${words[@]:2}")
      idx=$((CURRENT - 2))

      # Call gdx completion
      local out
      out="$(GDX_CMP_IDX="$idx" command gdx __completion "\${args[@]}" 2>/dev/null)"

      if [ -n "$out" ]; then
         # Use gdx suggestions
         local -a completions
         completions=("\${(f)out}")
         compadd -Q -a completions
         return 0
      fi

      # Fallback to git completion
      if (( $+functions[_git] )); then
         # Temporarily adjust words[1] to git
         local orig_word1="\${words[1]}"
         words[1]="git"
         _git
         words[1]="$orig_word1"
      fi
   }

   # Ensure completion system is loaded
   if ! (( $+functions[compdef] )); then
      autoload -Uz compinit
      compinit -u
   fi

   compdef __gdx_complete_zsh ${cmd}
   `;
};

export const generateFishScript = (cmd: string = 'gdx'): string => {
   return litedent`
   # gdx shell integration
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

   # Completion function for ${cmd}
   function __gdx_complete_fish
      # Get commandline tokens
      set -l tokens (commandline -opc)
      set -l current (commandline -ct)

      # Remove the command name itself
      set -e tokens[1]

      # Calculate cursor index
      set -l idx (math (count $tokens) - 1)
      if test $idx -lt 0
         set idx 0
      end

      # Call gdx completion
      set -l out (GDX_CMP_IDX=$idx command gdx __completion $tokens $current 2>/dev/null)

      # Output suggestions
      for suggestion in $out
         echo $suggestion
      end
   end

   # Register completions for ${cmd}
   # First, provide git-like fallback by default
   complete -c ${cmd} -w git

   # Then add gdx-specific completions (they take precedence)
   complete -c ${cmd} -f -a "(__gdx_complete_fish)"
   `;
};

export const generatePowershellScript = (cmd: string = 'gdx'): string => {
   return litedent`
   # gdx shell integration
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

   # Completion scriptblock for ${cmd}
   $__gdxCompleter = {
      param($wordToComplete, $commandAst, $cursorPosition)

      # Use AST to get properly parsed tokens (handles quotes correctly)
      $tokens = @($commandAst.CommandElements | ForEach-Object { $_.Extent.Text })

      # Remove the command name itself
      if ($tokens.Count -gt 0) {
         $tokens = @($tokens | Select-Object -Skip 1)
      }

      # Find cursor token index
      $idx = [Math]::Max(0, $tokens.Count - 1)

      # Call gdx completion
      $env:GDX_CMP_IDX = $idx
      try {
         $completions = & gdx __completion @tokens 2>$null

         if ($completions) {
            # Return gdx suggestions
            $completions | ForEach-Object {
                  [System.Management.Automation.CompletionResult]::new(
                     $_, $_, 'ParameterValue', $_
                  )
            }
            return
         }
      } finally {
         $env:GDX_CMP_IDX = $null
      }

      # Fallback to git completion if posh-git is available
      if (Get-Command -Name "GitTabExpansion" -ErrorAction SilentlyContinue) {
         $gitCompletions = GitTabExpansion $wordToComplete $commandAst
         if ($gitCompletions) {
            $gitCompletions | ForEach-Object {
                  if ($_ -is [System.Management.Automation.CompletionResult]) {
                     $_
                  } else {
                     [System.Management.Automation.CompletionResult]::new(
                        $_, $_, 'ParameterValue', $_
                     )
                  }
            }
         }
      }
   }

   Register-ArgumentCompleter -Native -CommandName ${cmd} -ScriptBlock $__gdxCompleter
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
