#!/usr/bin/env bash
set -euo pipefail

deb_path="${1:?Usage: build-apt-repo.sh <deb-path> <output-dir> [codename] [component] [architectures]}"
output_dir="${2:?Usage: build-apt-repo.sh <deb-path> <output-dir> [codename] [component] [architectures]}"
codename="${3:-stable}"
component="${4:-main}"
architectures="${5:-amd64 arm64 armhf i386}"
package_name="ollama-agent-router"

if [ -z "${APT_GPG_PRIVATE_KEY:-}" ]; then
  echo "APT_GPG_PRIVATE_KEY is required to publish a signed APT repository." >&2
  echo "Create a repository signing key and store the ASCII-armored private key as a GitHub secret." >&2
  exit 1
fi

mkdir -p "$output_dir/pool/main/o/$package_name"

cp "$deb_path" "$output_dir/pool/main/o/$package_name/"

pushd "$output_dir" >/dev/null

for arch in $architectures; do
  mkdir -p "dists/$codename/$component/binary-$arch"
  dpkg-scanpackages --arch "$arch" pool /dev/null > "dists/$codename/$component/binary-$arch/Packages"
  gzip -9fk "dists/$codename/$component/binary-$arch/Packages"
done

cat > apt-release.conf <<EOF
APT::FTPArchive::Release::Origin "ExeconOne";
APT::FTPArchive::Release::Label "ExeconOne";
APT::FTPArchive::Release::Suite "$codename";
APT::FTPArchive::Release::Codename "$codename";
APT::FTPArchive::Release::Architectures "$architectures";
APT::FTPArchive::Release::Components "$component";
APT::FTPArchive::Release::Description "ExeconOne APT repository";
EOF

apt-ftparchive -c apt-release.conf release "dists/$codename" > "dists/$codename/Release"
rm apt-release.conf

export GNUPGHOME
GNUPGHOME="$(mktemp -d)"
chmod 700 "$GNUPGHOME"
printf '%s\n' "$APT_GPG_PRIVATE_KEY" | gpg --batch --import
gpg --batch --yes --pinentry-mode loopback --passphrase "${APT_GPG_PASSPHRASE:-}" \
  --clearsign -o "dists/$codename/InRelease" "dists/$codename/Release"
gpg --batch --yes --pinentry-mode loopback --passphrase "${APT_GPG_PASSPHRASE:-}" \
  -abs -o "dists/$codename/Release.gpg" "dists/$codename/Release"
gpg --armor --export > gpg.key
rm -rf "$GNUPGHOME"

cat > README.txt <<EOF
ExeconOne APT repository

Signed repository:
  curl -fsSL https://execonone.github.io/ollama-agent-router/apt/gpg.key \\
    | sudo gpg --dearmor -o /usr/share/keyrings/ollama-agent-router.gpg

  echo "deb [signed-by=/usr/share/keyrings/ollama-agent-router.gpg] https://execonone.github.io/ollama-agent-router/apt $codename $component" \\
    | sudo tee /etc/apt/sources.list.d/ollama-agent-router.list

  sudo apt-get update
  sudo apt-get install ollama-agent-router
EOF

cat > ../index.html <<EOF
<!doctype html>
<html>
  <head><meta charset="utf-8"><title>ollama-agent-router APT repository</title></head>
  <body>
    <h1>ollama-agent-router APT repository</h1>
    <pre>deb https://execonone.github.io/ollama-agent-router/apt $codename $component</pre>
    <p>See <a href="./apt/README.txt">APT setup instructions</a>.</p>
  </body>
</html>
EOF

popd >/dev/null
