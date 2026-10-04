# Static condensed builds of mainline Noto Sans and Noto Sans Mono (all
# widths below normal: semi-, regular and extra-condensed). Firefox doesn't
# apply variations to installed variable fonts, so it can only render
# `font-stretch: condensed` from static faces like these.
{ stdenvNoCC, fetchzip }:
let
  sans = fetchzip {
    url = "https://github.com/notofonts/latin-greek-cyrillic/releases/download/NotoSans-v2.015/NotoSans-v2.015.zip";
    hash = "sha256-FQL9fTzA6QiYxN61CsZiaQOGBTxdjKy2U/sMPlr/VII=";
    stripRoot = false;
  };
  mono = fetchzip {
    url = "https://github.com/notofonts/latin-greek-cyrillic/releases/download/NotoSansMono-v2.014/NotoSansMono-v2.014.zip";
    hash = "sha256-MoFYRQYE3xG+nmstNFJ6pJTLWQaPnyrAovtFhL20nDE=";
    stripRoot = false;
  };
in
stdenvNoCC.mkDerivation {
  pname = "noto-sans-condensed-static";
  version = "2.015";
  dontUnpack = true;
  installPhase = ''
    mkdir -p $out/share/fonts/truetype
    find ${sans} ${mono} -path '*/unhinted/ttf/*' -name '*Condensed*.ttf' -exec cp {} $out/share/fonts/truetype/ \;
  '';
}
