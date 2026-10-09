import SwiftUI
import PhotosUI
import UIKit

struct CheckView: View {
    @Bindable var store: AppStore
    @State private var selection: [PhotosPickerItem] = []
    @State private var camera = false
    @State private var scanner = false
    @State private var importing = false
    @State private var importTask: Task<Void, Never>?
    @State private var preview: String?
    @FocusState private var editing: String?
    var body: some View {
        Form {
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    Label(L("Check a product"), systemImage: "leaf").font(.title2.bold())
                    Text(L("Start with the label. See what the evidence says.")).foregroundStyle(.secondary)
                }.padding(.vertical, 8)
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 16) { cameraButton; photoButton; barcodeButton }
                    VStack(alignment: .leading, spacing: 12) { cameraButton; photoButton; barcodeButton }
                }.labelStyle(CaptureLabelStyle()).padding(.vertical, 4)
                if importing { ProgressView(L("Preparing photos…")) }
                if !store.draftPhotos.isEmpty {
                    ScrollView(.horizontal) {
                        HStack(spacing: 12) {
                            ForEach(store.draftPhotos, id: \.self) { name in
                                VStack {
                                    Button { preview = name } label: {
                                        if let image = UIImage(contentsOfFile: store.files.url(name).path) { Image(uiImage: image).resizable().scaledToFill().frame(width: 88, height: 100).clipped().clipShape(RoundedRectangle(cornerRadius: 10)) }
                                    }.accessibilityLabel(L("Review photo"))
                                    Button(role: .destructive) { store.removePhoto(name) } label: { Label(L("Remove"), systemImage: "trash").font(.caption).frame(minHeight: 44) }
                                }.buttonStyle(.borderless)
                            }
                        }
                    }
                }
            }
            Section(L("Product details")) {
                TextField(L("Product name (optional)"), text: $store.draft.name).focused($editing, equals: "name").accessibilityIdentifier("productName")
                TextField(L("Brand (optional)"), text: $store.draft.brand).focused($editing, equals: "brand")
                TextField(L("Product country (e.g. SE)"), text: Binding(get: { store.draft.market }, set: { value in
                    store.draft.market = String(value.uppercased().filter { $0.isASCII && $0.isLetter }.prefix(2)); store.draft.autoMarket = false
                })).textInputAutocapitalization(.characters).autocorrectionDisabled().focused($editing, equals: "market")
                Text(L(store.draft.autoMarket == false || !store.settings.automaticCountry ? "Selected manually" : "Fallback country"))
                Text(L("Choose the country this product is sold for, not the manufacturer’s location.")).font(.footnote).foregroundStyle(.secondary)
                Picker(L("Category"), selection: $store.draft.category) { ForEach(Category.allCases) { Text($0.label).tag($0) } }.accessibilityIdentifier("categoryPicker")
                TextField(L("Barcode (optional)"), text: $store.draft.barcode).keyboardType(.numberPad).focused($editing, equals: "barcode").accessibilityIdentifier("barcode")
            }
            Section {
                TextField(L("Paste ingredients or materials"), text: $store.draft.text, axis: .vertical).lineLimit(5...12).focused($editing, equals: "ingredients").accessibilityIdentifier("ingredients")
                Toggle(L("This is the complete list"), isOn: Binding(get: { store.draft.complete == true }, set: { store.draft.complete = $0 })).accessibilityIdentifier("completeList")
            } header: { Text(L("Ingredients or materials")) } footer: { Text(L("Only mark a list complete when you have checked the entire label.")) }
            Section {
                Button { editing = nil; store.enqueue() } label: { Label(L("Check product"), systemImage: "sparkle.magnifyingglass").frame(maxWidth: .infinity, minHeight: 38) }
                    .buttonStyle(.borderedProminent).disabled(importing || store.draftSubmitted || !Locale.Region.isoRegions.contains(where: { $0.identifier == store.draft.market }) || !store.draft.hasContent && store.draftPhotos.isEmpty).accessibilityIdentifier("checkProduct")
                if store.draftSubmitted { Text(L("This draft is already queued. Clear it to start another check.")).font(.footnote) }
                if store.settings.offline { Label(L("Offline mode — local evidence only"), systemImage: "wifi.slash").font(.footnote).foregroundStyle(.secondary) }
                else if store.connectionReady(store.settings) { Text(L("Selected text and photos may be sent to your AI provider if local evidence is insufficient.")).font(.footnote).foregroundStyle(.secondary) }
            }
            if !store.jobs.isEmpty {
                Section(L("Checks in progress")) {
                    ForEach(store.jobs) { job in JobRow(store: store, job: job) }
                }
            }
        }
        .navigationTitle("Vegsnap")
        .toolbar { ToolbarItemGroup(placement: .keyboard) { Spacer(); Button(L("Done")) { editing = nil } }; ToolbarItem(placement: .topBarTrailing) { Button(L("Clear")) { store.clearDraft() }.disabled(!importing && !store.draftSubmitted && !store.draft.hasContent && store.draftPhotos.isEmpty) } }
        .onChange(of: store.draft) { _, _ in store.saveDraft() }
        .onChange(of: selection) { _, items in
            guard !items.isEmpty, !importing else { return }
            importing = true
            let draftID = store.draftID
            importTask = Task {
                defer { importing = false; selection = []; importTask = nil }
                do {
                    for item in items.prefix(max(0, 3 - store.draftPhotos.count)) {
                        try await store.importPhoto(for: draftID) { try await item.loadTransferable(type: PickedPhoto.self)?.data }
                    }
                } catch { if !Task.isCancelled && store.draftID == draftID { store.report(error) } }
            }
        }
        .onChange(of: store.draftID) { _, _ in importTask?.cancel() }
        .onDisappear { importTask?.cancel() }
        .sheet(isPresented: $camera) { CameraPicker { data in do { try store.addPhoto(data) } catch { store.report(error) } } }
        .sheet(isPresented: $scanner) { BarcodeScanner { code in store.draft.barcode = code; store.saveDraft() } }
        .sheet(isPresented: Binding(get: { preview != nil }, set: { if !$0 { preview = nil } })) {
            if let name = preview { PhotoReview(store: store, name: name) }
        }
    }
    private var cameraButton: some View { Button { camera = true } label: { Label(L("Camera"), systemImage: "camera").frame(minHeight: 44) }.buttonStyle(.borderless).disabled(!UIImagePickerController.isSourceTypeAvailable(.camera) || store.draftPhotos.count >= 3) }
    private var photoButton: some View { PhotosPicker(selection: $selection, maxSelectionCount: max(1, 3 - store.draftPhotos.count), matching: .images) { Label(L("Photos"), systemImage: "photo.on.rectangle").frame(minHeight: 44) }.buttonStyle(.borderless).disabled(importing || store.draftPhotos.count >= 3) }
    private var barcodeButton: some View { Button { scanner = true } label: { Label(L("Scan"), systemImage: "barcode.viewfinder").frame(minHeight: 44) }.buttonStyle(.borderless).disabled(!UIImagePickerController.isSourceTypeAvailable(.camera)) }
}
struct JobRow: View {
    var store: AppStore; var job: CheckJob
    var inactive: Bool { ["failed", "cancelled", "interrupted"].contains(job.status) }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(job.input.name.isEmpty ? String(job.input.text.prefix(60)).isEmpty ? L("Photo check") : String(job.input.text.prefix(60)) : job.input.name).font(.headline)
            if inactive { Label(L(job.status.capitalized), systemImage: "exclamationmark.circle") }
            else { HStack { ProgressView(); Text(L(["queued": "Queued", "evaluating": "Evaluating evidence…", "database": "Looking up product…", "ai": "Analyzing with AI…", "ocr": "Reading label on device…"][job.status] ?? "Working…")) } }
            if let error = job.error { Text(error).font(.footnote).foregroundStyle(.secondary) }
            HStack {
                if inactive { Button(L("Retry")) { store.retry(job.id) }; Spacer(); Button(L("Remove"), role: .destructive) { store.removeJob(job.id) } }
                else { Button(L("Cancel"), role: .cancel) { store.cancel(job.id) } }
            }.buttonStyle(.borderless).frame(minHeight: 44)
        }
    }
}
struct CameraPicker: UIViewControllerRepresentable {
    @Environment(\.dismiss) private var dismiss
    var onPhoto: (Data) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIViewController(context: Context) -> UIImagePickerController { let picker = UIImagePickerController(); picker.sourceType = .camera; picker.delegate = context.coordinator; return picker }
    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker; init(_ parent: CameraPicker) { self.parent = parent }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.9) { parent.onPhoto(data) }; parent.dismiss()
        }
    }
}
struct PhotoReview: View {
    var store: AppStore; var name: String
    @Environment(\.dismiss) private var dismiss
    @State private var revision = 0
    var body: some View {
        NavigationStack {
            Group {
                if let image = UIImage(contentsOfFile: store.files.url(name).path) { ZoomablePhoto(image: image).id(revision).accessibilityLabel(L("Product photo")) }
            }.navigationTitle(L("Review photo")).navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button(L("Done")) { dismiss() } }; ToolbarItem(placement: .bottomBar) { Button { do { let rotated = try PhotoProcessor.rotate(Data(contentsOf: store.files.url(name))); try store.files.saveData(rotated, name); revision += 1 } catch { store.report(error) } } label: { Label(L("Rotate"), systemImage: "rotate.right") } } }
        }
    }
}

struct ZoomablePhoto: UIViewRepresentable {
    var image: UIImage
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> UIScrollView {
        let view = UIScrollView(); view.delegate = context.coordinator; view.minimumZoomScale = 1; view.maximumZoomScale = 5
        let imageView = UIImageView(image: image); imageView.contentMode = .scaleAspectFit
        imageView.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(imageView)
        NSLayoutConstraint.activate([imageView.leadingAnchor.constraint(equalTo: view.contentLayoutGuide.leadingAnchor), imageView.trailingAnchor.constraint(equalTo: view.contentLayoutGuide.trailingAnchor), imageView.topAnchor.constraint(equalTo: view.contentLayoutGuide.topAnchor), imageView.bottomAnchor.constraint(equalTo: view.contentLayoutGuide.bottomAnchor), imageView.widthAnchor.constraint(equalTo: view.frameLayoutGuide.widthAnchor), imageView.heightAnchor.constraint(equalTo: view.frameLayoutGuide.heightAnchor)])
        context.coordinator.imageView = imageView
        view.accessibilityCustomActions = [UIAccessibilityCustomAction(name: L("Zoom in"), actionHandler: { _ in view.setZoomScale(min(5, view.zoomScale + 1), animated: !UIAccessibility.isReduceMotionEnabled); return true }), UIAccessibilityCustomAction(name: L("Zoom out"), actionHandler: { _ in view.setZoomScale(max(1, view.zoomScale - 1), animated: !UIAccessibility.isReduceMotionEnabled); return true })]
        view.isAccessibilityElement = true
        return view
    }
    func updateUIView(_ view: UIScrollView, context: Context) { context.coordinator.imageView?.image = image }
    final class Coordinator: NSObject, UIScrollViewDelegate {
        var imageView: UIImageView?
        func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }
    }
}

private struct CaptureLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        VStack(spacing: 6) { configuration.icon.font(.title2); configuration.title.font(.callout) }
            .frame(maxWidth: .infinity, minHeight: 52)
    }
}
