import SwiftUI

/// Also embedded by the Share Extension; depends on no launcher or WebKit UI.
struct SharedCaptureView: View {
    @ObservedObject var model: SharedCaptureModel
    var close: () -> Void

    var body: some View {
        #if os(macOS)
        MacSharedCaptureView(model: model, close: close)
        #else
        phoneBody
        #endif
    }

    private var phoneBody: some View {
        NavigationStack {
            Form {
                if model.receiving { ProgressView("Loading picture…") }
                if let receipt = model.receipt {
                    Section {
                        Label("Saved", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                        Text(verbatim: receipt)
                    }
                }
                if let draft = model.draft {
                    Section {
                        if let image = CapturePicture.preview(draft.image) {
                            captureImage(image).resizable().scaledToFit().frame(maxHeight: 240)
                                .accessibilityLabel(Text("Shared picture"))
                        }
                        Picker("Space", selection: Binding(get: { draft.connection ?? UUID() }, set: { id in
                            Task { await model.changeSpace(id) }
                        })) {
                            ForEach(model.spaces) { space in Text(verbatim: space.name).tag(space.id) }
                        }.disabled(model.busy || draft.attempted)
                        Picker("Save to", selection: Binding(get: { draft.target ?? "" }, set: { model.changeTarget($0) })) {
                            if model.targets.isEmpty { Text("No destination").tag("") }
                            ForEach(model.targets) { target in
                                Text(verbatim: target.displayTitle() + (target.peer.map { " · \($0)" } ?? "")).tag(target.id)
                            }
                        }.disabled(model.busy || model.loading || draft.attempted)
                        TextField("Add a note (optional)", text: Binding(get: { draft.text }, set: { model.changeText($0) }), axis: .vertical)
                            .lineLimit(2...5).disabled(model.busy || draft.attempted)
                        if draft.attempted {
                            Text("Retries keep the same picture and destination to avoid duplicate saves.")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        Button { Task { await model.save() } } label: {
                            if model.busy { ProgressView() } else { Text(draft.attempted ? String(localized: "Retry Save") : String(localized: "Save")) }
                        }.disabled(!model.canSave)
                    } footer: {
                        #if os(macOS)
                        Text("Unsaved pictures stay on this Mac in Space → Pending Shares.")
                        #else
                        Text("Unsaved pictures stay on this device in ai-space → Settings → Pending Shares.")
                        #endif
                    }
                }
                if model.loading { ProgressView("Loading destinations…") }
                if let error = model.error {
                    Section {
                        Text(verbatim: error).foregroundStyle(.red)
                        if model.draft != nil {
                            Button("Reload Destinations") { Task { await model.loadTargets() } }
                                .disabled(model.busy || model.loading)
                        }
                    }
                }
                if !model.drafts.isEmpty {
                    Section("Pending Shares") {
                        ForEach(model.drafts) { item in
                            HStack {
                                Button { Task { await model.edit(item) } } label: {
                                    HStack {
                                        if let image = CapturePicture.preview(item.image, maxPixelSize: 128) {
                                            captureImage(image).resizable().scaledToFit().frame(width: 44, height: 44)
                                        }
                                        Text(item.text.isEmpty ? String(localized: "Shared picture") : item.text).lineLimit(2)
                                    }
                                }.disabled(model.busy)
                                Spacer()
                                Button(role: .destructive) { model.deleting = item } label: { Image(systemName: "trash") }
                                    .buttonStyle(.borderless).disabled(model.busy).accessibilityLabel(Text("Delete"))
                            }
                        }
                    }
                } else if model.draft == nil && model.receipt == nil && model.error == nil && !model.receiving {
                    Text("No pending shares.")
                }
            }
            .navigationTitle("ai-space")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done", action: close).disabled(model.busy || model.receiving) } }
            .interactiveDismissDisabled(model.busy || model.receiving)
            .confirmationDialog("Delete this pending picture?", isPresented: Binding(get: { model.deleting != nil }, set: { if !$0 { model.deleting = nil } })) {
                Button("Delete", role: .destructive) { if let deleting = model.deleting { model.discard(deleting) }; model.deleting = nil }
            }
        }
    }
}

private func captureImage(_ image: CaptureImage) -> Image {
    #if os(macOS)
    return Image(nsImage: image)
    #else
    return Image(uiImage: image)
    #endif
}

#if os(macOS)
/// Extension hosts do not provide a navigation toolbar. Keep dismissal inside the content,
/// outside the scrolling editor, so it remains reachable at every host window size.
private struct MacSharedCaptureView: View {
    @ObservedObject var model: SharedCaptureModel
    var close: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("ai-space").font(.headline)
                Spacer()
                Button(model.receipt == nil ? String(localized: "Cancel") : String(localized: "Done"), action: close)
                    .keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("share.close")
            }.padding(16)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if model.receiving { ProgressView("Loading picture…") }
                    if let receipt = model.receipt {
                        Label("Saved", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                        Text(verbatim: receipt).fixedSize(horizontal: false, vertical: true)
                    }
                    if let draft = model.draft {
                        if let image = CapturePicture.preview(draft.image) {
                            Image(nsImage: image).resizable().scaledToFit()
                                .frame(maxWidth: .infinity).frame(height: 180)
                                .accessibilityLabel(Text("Shared picture"))
                        }
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Space")
                            Picker("Space", selection: Binding(get: { draft.connection ?? UUID() }, set: { id in
                                Task { await model.changeSpace(id) }
                            })) {
                                ForEach(model.spaces) { space in Text(verbatim: space.name).tag(space.id) }
                            }.labelsHidden().disabled(model.busy || draft.attempted)
                        }
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Save to")
                            Picker("Save to", selection: Binding(get: { draft.target ?? "" }, set: { model.changeTarget($0) })) {
                                if model.targets.isEmpty { Text("No destination").tag("") }
                                ForEach(model.targets) { target in
                                    Text(verbatim: target.displayTitle() + (target.peer.map { " · \($0)" } ?? "")).tag(target.id)
                                }
                            }.labelsHidden().disabled(model.busy || model.loading || draft.attempted)
                        }
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Add a note (optional)")
                            TextField("Add a note (optional)", text: Binding(get: { draft.text }, set: { model.changeText($0) }), axis: .vertical)
                                .labelsHidden().textFieldStyle(.roundedBorder).lineLimit(2...5)
                                .disabled(model.busy || draft.attempted)
                        }
                        if draft.attempted {
                            Text("Retries keep the same picture and destination to avoid duplicate saves.")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        Button { Task { await model.save() } } label: {
                            Text(draft.attempted ? String(localized: "Retry Save") : String(localized: "Save"))
                        }.disabled(!model.canSave)
                        if model.busy { ProgressView() }
                        Text("Unsaved pictures stay on this Mac in Space → Pending Shares.")
                            .font(.footnote).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if model.loading { ProgressView("Loading destinations…") }
                    if let error = model.error {
                        Text(verbatim: error).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
                        if model.draft != nil {
                            Button("Reload Destinations") { Task { await model.loadTargets() } }
                                .disabled(model.busy || model.loading)
                        }
                    }
                    if !model.drafts.isEmpty {
                        Divider()
                        Text("Pending Shares").font(.headline)
                        ForEach(model.drafts) { item in
                            HStack {
                                Button { Task { await model.edit(item) } } label: {
                                    HStack {
                                        if let image = CapturePicture.preview(item.image, maxPixelSize: 128) {
                                            Image(nsImage: image).resizable().scaledToFit().frame(width: 44, height: 44)
                                        }
                                        Text(item.text.isEmpty ? String(localized: "Shared picture") : item.text).lineLimit(2)
                                    }
                                }.disabled(model.busy)
                                Spacer()
                                Button(role: .destructive) { model.deleting = item } label: { Image(systemName: "trash") }
                                    .disabled(model.busy).accessibilityLabel(Text("Delete"))
                            }
                        }
                    } else if model.draft == nil && model.receipt == nil && model.error == nil && !model.receiving {
                        Text("No pending shares.")
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(16)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
        .confirmationDialog("Delete this pending picture?", isPresented: Binding(get: { model.deleting != nil }, set: { if !$0 { model.deleting = nil } })) {
            Button("Delete", role: .destructive) { if let deleting = model.deleting { model.discard(deleting) }; model.deleting = nil }
        }
    }
}
#endif
