{ runCommandLocal }:
runCommandLocal "pi-cc-commands" { } ''
                mkdir -p $out
                cp -r ${./.}/. $out/
                ''
