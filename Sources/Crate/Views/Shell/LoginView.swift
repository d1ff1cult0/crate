import SwiftUI

struct LoginView: View {
    @Environment(AppModel.self) private var app
    @State private var server = ""
    @State private var username = ""
    @State private var password = ""
    @State private var error: String?
    @State private var connecting = false

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            VStack(alignment: .leading, spacing: 20) {
                HStack(spacing: 10) {
                    CrateMark(size: 34, cutout: Tok.surface)
                    Wordmark(size: 26)
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("Connect to your server").textStyle(.titleLarge).foregroundStyle(Tok.fg)
                    Text("Crate works with Navidrome, directly or behind octo-fiesta.")
                        .textStyle(.small)
                        .foregroundStyle(Tok.fgMuted)
                }
                VStack(alignment: .leading, spacing: 14) {
                    field("Server") {
                        CrateTextField(placeholder: "music.example.com", text: $server, icon: "server.rack")
                    }
                    field("Username") {
                        CrateTextField(placeholder: "Your Navidrome user", text: $username, icon: "person")
                    }
                    field("Password") {
                        CrateTextField(placeholder: "Password", text: $password, icon: "lock", secure: true) { connect() }
                    }
                }
                if let error {
                    Callout(kind: .danger, message: error)
                }
                Button {
                    connect()
                } label: {
                    HStack(spacing: 8) {
                        if connecting { ProgressView().controlSize(.small).colorInvert() }
                        Text(connecting ? "Connecting…" : "Connect")
                    }
                }
                .buttonStyle(.crate(.primary, size: .lg, fullWidth: true))
                .disabled(connecting || server.isEmpty || username.isEmpty || password.isEmpty)
                .keyboardShortcut(.defaultAction)
                Text("Your password is stored in the macOS keychain. Crate signs requests with a salted token, so the password itself never travels over the network.")
                    .textStyle(.caption)
                    .foregroundStyle(Tok.fgPlaceholder)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(32)
            .frame(width: 420)
            .background(Tok.surface, in: RoundedRectangle(cornerRadius: Radius.panel, style: .continuous))
            .hairline(Radius.panel)
            .shadow(color: .black.opacity(0.04), radius: 2, y: 1)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Tok.canvas)
        .onAppear {
            if let saved = app.settings.savedAccount {
                server = saved.url.absoluteString
                username = saved.username
            }
        }
    }

    private func field<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).textStyle(.smallStrong).foregroundStyle(Tok.fgSecondary)
            content()
        }
    }

    private func connect() {
        guard !connecting else { return }
        connecting = true
        error = nil
        Task {
            do {
                try await app.login(server: server, username: username, password: password)
            } catch {
                self.error = error.isConnectivityError
                    ? "Couldn't reach \(server). Check the address and your connection."
                    : error.localizedDescription
            }
            connecting = false
        }
    }
}
