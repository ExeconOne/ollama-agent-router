class OllamaAgentRouter < Formula
  desc "OpenAI-compatible router for Ollama with GPU/CPU-aware queues"
  homepage "https://github.com/ExeconOne/ollama-agent-router"
  url "https://registry.npmjs.org/ollama-agent-router/-/ollama-agent-router-0.1.0.tgz"
  sha256 "9de0db60829bdf6e067f7f39f70b9a4588c012a0119fbd067f196a641e0e6090"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args

    bin.install_symlink libexec/"bin/ollama-agent-router"
    bin.install_symlink libexec/"bin/oar"

    pkgshare.install "examples"
    (etc/"ollama-agent-router").install "examples/gex44.yaml" => "gex44.example.yaml"
  end

  def post_install
    (etc/"ollama-agent-router").mkpath
    (var/"ollama-agent-router").mkpath
  end

  service do
    run [opt_bin/"ollama-agent-router", "serve", "--config", etc/"ollama-agent-router/config.yaml"]
    working_dir var/"ollama-agent-router"
    keep_alive true
    log_path var/"log/ollama-agent-router.log"
    error_log_path var/"log/ollama-agent-router.err.log"
  end

  def caveats
    <<~EOS
      Generate a machine-specific config before running the service:
        ollama-agent-router configure --output #{etc}/ollama-agent-router/config.yaml

      Start the router:
        ollama-agent-router serve --config #{etc}/ollama-agent-router/config.yaml

      Or run it as a Homebrew service:
        brew services start ollama-agent-router

      Linux hosts with NVIDIA GPUs can use nvidia-smi for VRAM monitoring.
      macOS hosts are configured with Apple Silicon/unified-memory-safe defaults.
    EOS
  end

  test do
    assert_match "Usage: ollama-agent-router", shell_output("#{bin}/ollama-agent-router --help")
    assert_match "Usage: ollama-agent-router", shell_output("#{bin}/oar --help")
  end
end
