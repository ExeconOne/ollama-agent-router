class OllamaAgentRouter < Formula
  desc "Intelligent HTTP and CLI router for Ollama"
  homepage "https://github.com/ExeconOne/ollama-agent-router"
  url "https://registry.npmjs.org/ollama-agent-router/-/ollama-agent-router-0.1.0.tgz"
  sha256 "REPLACE_WITH_TARBALL_SHA256"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec/"bin/ollama-agent-router"
    bin.install_symlink libexec/"bin/oar"
  end

  service do
    run [opt_bin/"ollama-agent-router", "serve", "--config", etc/"ollama-agent-router/config.yaml"]
    keep_alive true
    log_path var/"log/ollama-agent-router.log"
    error_log_path var/"log/ollama-agent-router.err.log"
  end

  test do
    assert_match "ollama-agent-router", shell_output("#{bin}/ollama-agent-router --help")
  end
end
