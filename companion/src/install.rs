//! Current-user installation and browser registration; never needs administrator access.
use serde_json::{Value, json};
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

const HOST: &str = "org.vegsnap.companion";
const FIREFOX_ID: &str = "vegsnap@vegsnap.app";
// Chrome Web Store and GitHub release packages.
const CHROMIUM_IDS: [&str; 2] = [
    "pkkfmbgdbdoccbdngnbfpjjhpldmphej",
    "bljmddjdbglldnbdhdfdlbilieoheend",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Browser {
    Firefox,
    Chromium,
    Chrome,
    Brave,
    Helium,
    Vivaldi,
    Edge,
    Zen,
    LibreWolf,
}

impl Browser {
    pub const ALL: [Self; 9] = [
        Self::Firefox,
        Self::Chromium,
        Self::Chrome,
        Self::Brave,
        Self::Helium,
        Self::Vivaldi,
        Self::Edge,
        Self::Zen,
        Self::LibreWolf,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::Firefox => "Firefox",
            Self::Chromium => "Chromium",
            Self::Chrome => "Google Chrome",
            Self::Brave => "Brave",
            Self::Helium => "Helium",
            Self::Vivaldi => "Vivaldi",
            Self::Edge => "Microsoft Edge",
            Self::Zen => "Zen",
            Self::LibreWolf => "LibreWolf",
        }
    }

    fn key(self) -> &'static str {
        match self {
            Self::Firefox => "firefox",
            Self::Chromium => "chromium",
            Self::Chrome => "chrome",
            Self::Brave => "brave",
            Self::Helium => "helium",
            Self::Vivaldi => "vivaldi",
            Self::Edge => "edge",
            Self::Zen => "zen",
            Self::LibreWolf => "librewolf",
        }
    }

    fn gecko(self) -> bool {
        matches!(self, Self::Firefox | Self::Zen | Self::LibreWolf)
    }

    /// Brave, Helium and Vivaldi retain Chromium's Chrome registry fallback.
    #[cfg(any(windows, test))]
    fn registry_key(self) -> String {
        let base = match self {
            Self::Firefox | Self::Zen | Self::LibreWolf => r"Software\Mozilla",
            Self::Chrome | Self::Brave | Self::Helium | Self::Vivaldi => r"Software\Google\Chrome",
            Self::Chromium => r"Software\Chromium",
            Self::Edge => r"Software\Microsoft\Edge",
        };
        format!(r"{base}\NativeMessagingHosts\{HOST}")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    Linux,
    Mac,
    Windows,
}

/// Current-user directories. Tests supply their own to cover every OS.
pub struct Layout {
    pub os: Os,
    pub home: PathBuf,
    /// `$XDG_CONFIG_HOME`, `~/Library/Application Support` or `%APPDATA%`.
    pub config: PathBuf,
    /// `%LOCALAPPDATA%` on Windows.
    pub local: PathBuf,
}

fn join(base: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .fold(base.to_path_buf(), |path, part| path.join(part))
}

impl Layout {
    pub fn current() -> io::Result<Self> {
        let os = if cfg!(windows) {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::Mac
        } else {
            Os::Linux
        };
        let directories = directories::BaseDirs::new()
            .ok_or_else(|| io::Error::other("Cannot find your home directory."))?;
        Ok(Self {
            os,
            home: directories.home_dir().into(),
            config: directories.config_dir().into(),
            local: directories.data_local_dir().into(),
        })
    }

    /// Earlier manual installations used the same location, so updates replace them.
    pub fn binary(&self) -> PathBuf {
        match self.os {
            Os::Linux => join(&self.home, ".local/lib/vegsnap/vegsnap-companion"),
            Os::Mac => join(&self.config, "Vegsnap/vegsnap-companion"),
            Os::Windows => join(&self.local, "Vegsnap/Companion/vegsnap-companion.exe"),
        }
    }

    pub fn manifest(&self, browser: Browser) -> PathBuf {
        use Browser::*;
        let directory = match (self.os, browser) {
            (Os::Windows, _) => {
                join(&self.local, "Vegsnap/NativeMessagingHosts").join(browser.key())
            }
            (Os::Linux, Firefox | Zen) => join(&self.home, ".mozilla/native-messaging-hosts"),
            (Os::Linux, LibreWolf) => join(&self.home, ".librewolf/native-messaging-hosts"),
            (Os::Linux, _) => {
                join(&self.config, chromium_directory(browser)).join("NativeMessagingHosts")
            }
            (Os::Mac, _) => join(
                &self.config,
                match browser {
                    Firefox | Zen => "Mozilla",
                    // Brave explicitly looks in Chrome's directory on macOS.
                    Chrome | Brave => "Google/Chrome",
                    Chromium => "Chromium",
                    Helium => "net.imput.helium",
                    Vivaldi => "Vivaldi",
                    Edge => "Microsoft Edge",
                    LibreWolf => "LibreWolf",
                },
            )
            .join("NativeMessagingHosts"),
        };
        directory.join(format!("{HOST}.json"))
    }

    /// Browsers create these profile directories when they first start.
    pub fn detected(&self, browser: Browser) -> bool {
        use Browser::*;
        let candidates = match (self.os, browser) {
            (Os::Linux, Firefox) => vec![
                join(&self.home, ".mozilla/firefox"),
                join(&self.config, "mozilla/firefox"),
            ],
            (Os::Linux, Zen) => vec![join(&self.home, ".zen")],
            (Os::Linux, LibreWolf) => vec![join(&self.home, ".librewolf")],
            (Os::Linux, _) => vec![join(&self.config, chromium_directory(browser))],
            (Os::Mac, _) => vec![join(
                &self.config,
                match browser {
                    Firefox => "Firefox",
                    Zen => "zen",
                    LibreWolf => "librewolf",
                    Chrome => "Google/Chrome",
                    Chromium => "Chromium",
                    Brave => "BraveSoftware/Brave-Browser",
                    Helium => "net.imput.helium",
                    Vivaldi => "Vivaldi",
                    Edge => "Microsoft Edge",
                },
            )],
            (Os::Windows, Firefox) => vec![join(&self.config, "Mozilla/Firefox")],
            (Os::Windows, Zen) => vec![join(&self.config, "zen")],
            (Os::Windows, LibreWolf) => vec![join(&self.config, "librewolf")],
            (Os::Windows, _) => vec![join(
                &self.local,
                match browser {
                    Chrome => "Google/Chrome",
                    Brave => "BraveSoftware/Brave-Browser",
                    Helium => "imput/Helium",
                    Vivaldi => "Vivaldi",
                    Edge => "Microsoft/Edge",
                    _ => "Chromium",
                },
            )],
        };
        candidates.iter().any(|path| path.is_dir())
    }

    /// Browsers sharing a location or registry key report the same state.
    pub fn registered(&self, browser: Browser) -> bool {
        #[cfg(windows)]
        if self.os == Os::Windows {
            return registry::manifest(&browser.registry_key())
                .is_some_and(|path| Path::new(&path).is_file());
        }
        self.manifest(browser).is_file()
    }

    /// Registers `selected` browsers and removes every other registration.
    /// A shared location stays registered while any browser using it is selected.
    /// Every location is attempted, so one failure cannot block the other browsers.
    pub fn register(&self, binary: &Path, selected: &[Browser]) -> io::Result<()> {
        let mut outcome = Ok(());
        for browser in Browser::ALL {
            let path = self.manifest(browser);
            outcome = outcome.and(
                if selected.iter().any(|choice| self.manifest(*choice) == path) {
                    write_manifest(&path, binary, browser)
                } else {
                    remove(&path)
                },
            );
        }
        #[cfg(windows)]
        if self.os == Os::Windows {
            for browser in Browser::ALL {
                let key = browser.registry_key();
                outcome = outcome.and(
                    match selected.iter().find(|choice| choice.registry_key() == key) {
                        Some(choice) => registry::set(&key, &self.manifest(*choice)),
                        None => registry::delete(&key),
                    },
                );
            }
        }
        outcome
    }

    /// Copies the running program to [`Self::binary`] and registers it.
    pub fn install(&self, selected: &[Browser]) -> io::Result<()> {
        let target = self.binary();
        copy_program(&std::env::current_exe()?, &target)?;
        self.register(&target, selected)
    }

    pub fn uninstall(&self) -> io::Result<()> {
        let target = self.binary();
        self.register(&target, &[])?;
        remove_program(&target)?;
        if self.os == Os::Windows {
            for directory in [
                "Vegsnap/Companion",
                "Vegsnap/NativeMessagingHosts",
                "Vegsnap",
            ] {
                let _ = fs::remove_dir(join(&self.local, directory));
            }
        }
        Ok(())
    }
}

fn chromium_directory(browser: Browser) -> &'static str {
    match browser {
        Browser::Chrome => "google-chrome",
        Browser::Brave => "BraveSoftware/Brave-Browser",
        Browser::Helium => "net.imput.helium",
        Browser::Vivaldi => "vivaldi",
        Browser::Edge => "microsoft-edge",
        _ => "chromium",
    }
}

fn write_manifest(path: &Path, binary: &Path, browser: Browser) -> io::Result<()> {
    fs::create_dir_all(path.parent().expect("manifest directory"))?;
    let data = serde_json::to_string_pretty(&manifest_json(binary, browser)?)?;
    fs::write(path, data + "\n")
}

fn manifest_json(binary: &Path, browser: Browser) -> io::Result<Value> {
    let path = binary
        .to_str()
        .ok_or_else(|| io::Error::other("The installation path must be valid Unicode."))?;
    let mut manifest = json!({
        "name": HOST,
        "description": "Vegsnap optional ChatGPT connection",
        "path": path,
        "type": "stdio",
    });
    if browser.gecko() {
        manifest["allowed_extensions"] = json!([FIREFOX_ID]);
    } else {
        manifest["allowed_origins"] = CHROMIUM_IDS
            .iter()
            .map(|id| format!("chrome-extension://{id}/"))
            .collect();
    }
    Ok(manifest)
}

/// Removes a file and then its directory if that became empty.
fn remove(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => {
            if let Some(directory) = path.parent() {
                let _ = fs::remove_dir(directory);
            }
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// Windows cannot delete a running program, such as this setup or a browser's host,
/// but it can move it. Its temporary folder cleanup removes the moved copy later.
fn remove_program(path: &Path) -> io::Result<()> {
    let result = remove(path);
    #[cfg(windows)]
    if result.is_err() {
        let moved =
            std::env::temp_dir().join(format!("vegsnap-companion-{}.old", uuid::Uuid::new_v4()));
        if fs::rename(path, moved).is_ok() {
            return Ok(());
        }
    }
    result
}

/// Writes a fresh file, so download quarantine attributes stay on the downloaded copy.
fn copy_program(source: &Path, target: &Path) -> io::Result<()> {
    if let (Ok(source), Ok(target)) = (fs::canonicalize(source), fs::canonicalize(target))
        && source == target
    {
        return Ok(());
    }
    fs::create_dir_all(target.parent().expect("installation directory"))?;
    // A separate staging file keeps concurrent setup windows from replacing each other's copy.
    let staged = target.with_extension(format!("{}.new", uuid::Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o755);
    let result = (|| {
        io::copy(&mut File::open(source)?, &mut options.open(&staged)?)?;
        // Windows cannot replace a program that a browser still runs.
        if cfg!(windows) {
            remove_program(target)?;
        }
        fs::rename(&staged, target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staged);
    }
    result
}

#[cfg(windows)]
mod registry {
    use std::io;
    use std::path::Path;
    use winreg::{RegKey, enums::HKEY_CURRENT_USER};

    pub fn manifest(key: &str) -> Option<String> {
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(key)
            .and_then(|key| key.get_value(""))
            .ok()
    }

    pub fn set(key: &str, manifest: &Path) -> io::Result<()> {
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(key)?;
        key.set_value("", &manifest.as_os_str())
    }

    pub fn delete(key: &str) -> io::Result<()> {
        match RegKey::predef(HKEY_CURRENT_USER).delete_subkey(key) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let root =
                std::env::temp_dir().join(format!("vegsnap-install-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn layout(&self, os: Os) -> Layout {
            Layout {
                os,
                home: self.root.join("home"),
                config: self.root.join("config"),
                local: self.root.join("local"),
            }
        }

        fn read(&self, path: &Path) -> Value {
            serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn linux_uses_browser_directories_and_xdg_config() {
        let fixture = Fixture::new("linux");
        let layout = fixture.layout(Os::Linux);
        let home = &layout.home;
        let config = &layout.config;
        let expected = [
            (
                Browser::Firefox,
                home.join(".mozilla/native-messaging-hosts"),
            ),
            (
                Browser::Chromium,
                config.join("chromium/NativeMessagingHosts"),
            ),
            (
                Browser::Chrome,
                config.join("google-chrome/NativeMessagingHosts"),
            ),
            (
                Browser::Brave,
                config.join("BraveSoftware/Brave-Browser/NativeMessagingHosts"),
            ),
            (
                Browser::Helium,
                config.join("net.imput.helium/NativeMessagingHosts"),
            ),
            (
                Browser::Vivaldi,
                config.join("vivaldi/NativeMessagingHosts"),
            ),
            (
                Browser::Edge,
                config.join("microsoft-edge/NativeMessagingHosts"),
            ),
            (Browser::Zen, home.join(".mozilla/native-messaging-hosts")),
            (
                Browser::LibreWolf,
                home.join(".librewolf/native-messaging-hosts"),
            ),
        ];
        for (browser, directory) in expected {
            assert_eq!(
                layout.manifest(browser),
                directory.join("org.vegsnap.companion.json")
            );
        }
        assert_eq!(
            layout.binary(),
            home.join(".local/lib/vegsnap/vegsnap-companion")
        );
    }

    #[test]
    fn macos_uses_browser_directories() {
        let fixture = Fixture::new("macos");
        let layout = fixture.layout(Os::Mac);
        let support = &layout.config;
        let expected = [
            (Browser::Firefox, "Mozilla"),
            (Browser::Chromium, "Chromium"),
            (Browser::Chrome, "Google/Chrome"),
            (Browser::Brave, "Google/Chrome"),
            (Browser::Helium, "net.imput.helium"),
            (Browser::Vivaldi, "Vivaldi"),
            (Browser::Edge, "Microsoft Edge"),
            (Browser::Zen, "Mozilla"),
            (Browser::LibreWolf, "LibreWolf"),
        ];
        for (browser, directory) in expected {
            assert_eq!(
                layout.manifest(browser),
                support
                    .join(directory)
                    .join("NativeMessagingHosts/org.vegsnap.companion.json")
            );
        }
        assert_eq!(layout.binary(), support.join("Vegsnap/vegsnap-companion"));
    }

    #[test]
    fn windows_keeps_a_manifest_per_browser_and_shares_registry_keys() {
        let fixture = Fixture::new("windows");
        let layout = fixture.layout(Os::Windows);
        let expected = [
            (Browser::Firefox, r"Software\Mozilla"),
            (Browser::Chromium, r"Software\Chromium"),
            (Browser::Chrome, r"Software\Google\Chrome"),
            (Browser::Brave, r"Software\Google\Chrome"),
            (Browser::Helium, r"Software\Google\Chrome"),
            (Browser::Vivaldi, r"Software\Google\Chrome"),
            (Browser::Edge, r"Software\Microsoft\Edge"),
            (Browser::Zen, r"Software\Mozilla"),
            (Browser::LibreWolf, r"Software\Mozilla"),
        ];
        for (browser, key) in expected {
            assert_eq!(
                browser.registry_key(),
                format!(r"{key}\NativeMessagingHosts\org.vegsnap.companion")
            );
            assert_eq!(
                layout.manifest(browser),
                layout
                    .local
                    .join("Vegsnap")
                    .join("NativeMessagingHosts")
                    .join(browser.key())
                    .join("org.vegsnap.companion.json")
            );
        }
        assert_eq!(
            layout.binary(),
            layout
                .local
                .join("Vegsnap")
                .join("Companion")
                .join("vegsnap-companion.exe")
        );
    }

    #[test]
    fn manifests_allow_only_vegsnap_extensions() {
        let binary = Path::new("/opt/vegsnap-companion");
        for browser in Browser::ALL {
            let data = manifest_json(binary, browser).unwrap();
            assert_eq!(data["name"], "org.vegsnap.companion");
            assert_eq!(data["path"], "/opt/vegsnap-companion");
            assert_eq!(data["type"], "stdio");
            if browser.gecko() {
                assert_eq!(data["allowed_extensions"], json!(["vegsnap@vegsnap.app"]));
                assert!(data.get("allowed_origins").is_none());
            } else {
                assert_eq!(
                    data["allowed_origins"],
                    json!([
                        "chrome-extension://pkkfmbgdbdoccbdngnbfpjjhpldmphej/",
                        "chrome-extension://bljmddjdbglldnbdhdfdlbilieoheend/"
                    ])
                );
                assert!(data.get("allowed_extensions").is_none());
            }
        }
    }

    #[test]
    fn registration_follows_the_selection_and_keeps_shared_locations() {
        let fixture = Fixture::new("register");
        let layout = fixture.layout(Os::Linux);
        let binary = layout.binary();
        layout
            .register(&binary, &[Browser::Firefox, Browser::Brave])
            .unwrap();
        let registered = |browser| layout.registered(browser);
        assert!(registered(Browser::Firefox) && registered(Browser::Brave));
        // Zen reads Firefox's manifest on Linux.
        assert!(registered(Browser::Zen));
        assert!(!registered(Browser::Chrome) && !registered(Browser::LibreWolf));
        let data = fixture.read(&layout.manifest(Browser::Brave));
        assert_eq!(data["path"], binary.to_str().unwrap());

        layout.register(&binary, &[Browser::Zen]).unwrap();
        assert!(registered(Browser::Firefox) && registered(Browser::Zen));
        assert!(!registered(Browser::Brave));
        assert!(!layout.manifest(Browser::Brave).parent().unwrap().exists());

        layout.register(&binary, &[]).unwrap();
        assert!(Browser::ALL.into_iter().all(|browser| !registered(browser)));
    }

    #[test]
    fn removal_keeps_other_native_hosts() {
        let fixture = Fixture::new("other-hosts");
        let layout = fixture.layout(Os::Linux);
        let directory = layout
            .manifest(Browser::Chrome)
            .parent()
            .unwrap()
            .to_path_buf();
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("org.example.json"), "{}").unwrap();
        layout
            .register(&layout.binary(), &[Browser::Chrome])
            .unwrap();
        layout.register(&layout.binary(), &[]).unwrap();
        assert!(directory.join("org.example.json").is_file());
        assert!(!layout.registered(Browser::Chrome));
    }

    // Root ignores directory permissions, so only unprivileged runs reach the failure.
    #[cfg(unix)]
    #[test]
    fn a_locked_location_does_not_block_other_browsers() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new("locked");
        let layout = fixture.layout(Os::Linux);
        let binary = layout.binary();
        layout.register(&binary, &[Browser::Chrome]).unwrap();
        let locked = layout
            .manifest(Browser::Chrome)
            .parent()
            .unwrap()
            .to_path_buf();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).unwrap();
        let result = layout.register(&binary, &[Browser::LibreWolf]);
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        // LibreWolf comes after Chrome, so stopping at the first error would skip it.
        assert!(layout.registered(Browser::LibreWolf));
        if layout.registered(Browser::Chrome) {
            assert!(result.is_err());
        }
    }

    #[test]
    fn detection_uses_profile_directories() {
        let fixture = Fixture::new("detect");
        let layout = fixture.layout(Os::Linux);
        assert!(
            Browser::ALL
                .into_iter()
                .all(|browser| !layout.detected(browser))
        );
        fs::create_dir_all(layout.config.join("mozilla/firefox")).unwrap();
        fs::create_dir_all(layout.config.join("BraveSoftware/Brave-Browser")).unwrap();
        let detected: Vec<_> = Browser::ALL
            .into_iter()
            .filter(|browser| layout.detected(*browser))
            .collect();
        assert_eq!(detected, [Browser::Firefox, Browser::Brave]);
    }

    #[test]
    fn program_copies_replace_older_versions_and_uninstall_cleans_up() {
        let fixture = Fixture::new("copy");
        let layout = fixture.layout(Os::Linux);
        let source = fixture.root.join("download");
        fs::write(&source, "new").unwrap();
        let target = layout.binary();
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, "old").unwrap();
        copy_program(&source, &target).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
        let files: Vec<_> = fs::read_dir(target.parent().unwrap()).unwrap().collect();
        assert_eq!(files.len(), 1, "only the installed program remains");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&target).unwrap().permissions().mode() & 0o777,
                0o755
            );
        }
        // Running the installed copy again leaves it in place.
        copy_program(&target, &target).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");

        layout.register(&target, &[Browser::Firefox]).unwrap();
        layout.uninstall().unwrap();
        assert!(!target.parent().unwrap().exists());
        assert!(!layout.registered(Browser::Firefox));
    }

    // On Windows hosts this layout would also change the real registry.
    #[cfg(not(windows))]
    #[test]
    fn windows_uninstall_removes_the_empty_vegsnap_directory() {
        let fixture = Fixture::new("windows-uninstall");
        let layout = fixture.layout(Os::Windows);
        let target = layout.binary();
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, "program").unwrap();
        layout
            .register(&target, &[Browser::Edge, Browser::Firefox])
            .unwrap();
        layout.uninstall().unwrap();
        assert!(!layout.local.join("Vegsnap").exists());
        assert!(layout.local.exists());
    }
}
