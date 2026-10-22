//! Setup window shown when someone opens the companion instead of a browser.
use crate::install::{Browser, Layout, Os};
use crate::strings::{self, Strings};
use eframe::egui;
use std::io;

struct Choice {
    browser: Browser,
    selected: bool,
    registered: bool,
}

struct Setup {
    text: &'static Strings,
    layout: Result<Layout, String>,
    choices: Vec<Choice>,
    installed: bool,
    message: Option<Result<String, String>>,
}

impl Setup {
    fn new(text: &'static Strings) -> Self {
        let layout = Layout::current().map_err(|error| failure(text, &error));
        let mut setup = Self {
            text,
            message: layout.as_ref().err().cloned().map(Err),
            layout,
            choices: Vec::new(),
            installed: false,
        };
        setup.refresh();
        setup
    }

    /// Selects registered browsers, or detected ones before the first installation.
    fn refresh(&mut self) {
        let Ok(layout) = &self.layout else { return };
        self.installed = layout.binary().is_file();
        let registered = Browser::ALL.map(|browser| layout.registered(browser));
        let any = registered.contains(&true);
        self.choices = Browser::ALL
            .into_iter()
            .zip(registered)
            .map(|(browser, registered)| Choice {
                browser,
                registered,
                selected: if any {
                    registered
                } else {
                    layout.detected(browser)
                },
            })
            .collect();
    }

    fn run(&mut self, action: impl FnOnce(&Layout) -> io::Result<()>, success: &str) {
        let Ok(layout) = &self.layout else { return };
        self.message = Some(match action(layout) {
            Ok(()) => Ok(success.to_owned()),
            Err(error) => Err(failure(self.text, &error)),
        });
        self.refresh();
    }
}

fn failure(text: &Strings, error: &io::Error) -> String {
    text.failed.replace("{error}", &error.to_string())
}

impl eframe::App for Setup {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let text = self.text;
        egui::CentralPanel::default_margins().show(ui, |ui| {
            egui::ScrollArea::vertical().show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.heading(text.title);
                    ui.weak(env!("CARGO_PKG_VERSION"));
                });
                ui.label(text.intro);
                ui.add_space(12.0);
                ui.strong(text.browsers);
                egui::Grid::new("browsers")
                    .num_columns(2)
                    .spacing([24.0, 6.0])
                    .show(ui, |ui| {
                        for choice in &mut self.choices {
                            ui.checkbox(&mut choice.selected, choice.browser.name());
                            if choice.registered {
                                ui.weak(text.registered);
                            } else {
                                ui.label("");
                            }
                            ui.end_row();
                        }
                    });
                ui.add_space(12.0);
                let selected: Vec<_> = self
                    .choices
                    .iter()
                    .filter(|choice| choice.selected)
                    .map(|choice| choice.browser)
                    .collect();
                let registered = self.choices.iter().any(|choice| choice.registered);
                let mut install = false;
                let mut uninstall = false;
                ui.horizontal(|ui| {
                    let label = if self.installed {
                        text.update
                    } else {
                        text.install
                    };
                    // The website's primary button colors.
                    let (fill, color) = if ui.visuals().dark_mode {
                        (
                            egui::Color32::from_rgb(0xac, 0xd3, 0x98),
                            egui::Color32::from_rgb(0x17, 0x30, 0x1e),
                        )
                    } else {
                        (
                            egui::Color32::from_rgb(0x23, 0x4d, 0x38),
                            egui::Color32::from_rgb(0xff, 0xfe, 0xf9),
                        )
                    };
                    let size = egui::vec2(110.0, 30.0);
                    let primary = egui::Button::new(egui::RichText::new(label).color(color))
                        .fill(fill)
                        .min_size(size);
                    install = ui.add_enabled(!selected.is_empty(), primary).clicked();
                    let secondary = egui::Button::new(text.uninstall).min_size(size);
                    uninstall = ui
                        .add_enabled(self.installed || registered, secondary)
                        .clicked();
                });
                if install {
                    self.run(|layout| layout.install(&selected), text.installed);
                } else if uninstall {
                    self.run(Layout::uninstall, text.removed);
                }
                match &self.message {
                    Some(Ok(message)) => {
                        ui.add_space(8.0);
                        ui.label(message);
                    }
                    Some(Err(message)) => {
                        ui.add_space(8.0);
                        ui.colored_label(ui.visuals().error_fg_color, message);
                    }
                    None => {}
                }
                ui.add_space(12.0);
                if let Ok(layout) = &self.layout {
                    if self.installed {
                        let path = layout.binary();
                        let folder = path.parent().unwrap_or(&path).display().to_string();
                        ui.weak(text.location.replace("{path}", &folder));
                        ui.weak(text.saved_accounts);
                    }
                    if layout.os == Os::Linux {
                        ui.weak(text.wallet);
                    }
                }
                // Recipients of the single Windows executable get no separate license file.
                ui.add_space(12.0);
                ui.weak(text.license_notice);
                egui::CollapsingHeader::new(text.license).show(ui, |ui| {
                    ui.label(
                        egui::RichText::new(include_str!("../../LICENSE"))
                            .monospace()
                            .small(),
                    );
                });
            });
        });
    }
}

fn language() -> &'static Strings {
    let locale = sys_locale::get_locale().unwrap_or_default().to_lowercase();
    if locale.starts_with("de") {
        &strings::DE
    } else if locale.starts_with("sv") {
        &strings::SV
    } else {
        &strings::EN
    }
}

pub fn run() -> eframe::Result {
    let text = language();
    let mut viewport = egui::ViewportBuilder::default()
        .with_title(text.title)
        .with_app_id("org.vegsnap.companion")
        .with_inner_size([480.0, 580.0])
        .with_min_inner_size([360.0, 320.0]);
    if let Ok(icon) =
        eframe::icon_data::from_png_bytes(include_bytes!("../../extension/public/icons/128.png"))
    {
        viewport = viewport.with_icon(icon);
    }
    let options = eframe::NativeOptions {
        viewport,
        ..Default::default()
    };
    eframe::run_native(
        text.title,
        options,
        Box::new(move |context| {
            context.egui_ctx.set_zoom_factor(1.1);
            Ok(Box::new(Setup::new(text)))
        }),
    )
}
