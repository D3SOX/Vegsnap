#!/usr/bin/env python3
"""Generate a deterministic Xcode project using only Python's standard library."""
import hashlib
import json
from pathlib import Path
import plistlib

root = Path(__file__).resolve().parent
objects = {}
def ident(key): return hashlib.sha256(key.encode()).hexdigest()[:24].upper()
def add(key, isa, **fields):
    key = ident(key); objects[key] = dict(isa=isa, **fields); return key
def ref(path, kind=None): return add('file:'+path, 'PBXFileReference', path=path, sourceTree='<group>', **({'lastKnownFileType':kind} if kind else {}))
def buildfile(path, **extra): return add('build:'+path, 'PBXBuildFile', fileRef=ref(path), **extra)
products = []; children = []; targets = []
for name, folder, product, kind in [('Vegsnap','Vegsnap','Vegsnap.app','application'),('VegsnapShare','ShareExtension','VegsnapShare.appex','app-extension'),('VegsnapTests','VegsnapTests','VegsnapTests.xctest','bundle.unit-test'),('VegsnapUITests','VegsnapUITests','VegsnapUITests.xctest','bundle.ui-testing')]:
    files = sorted(p.relative_to(root).as_posix() for p in (root/folder).rglob('*.swift'))
    sources = add(name+':sources','PBXSourcesBuildPhase',buildActionMask=2147483647,files=[buildfile(p) for p in files],runOnlyForDeploymentPostprocessing=0)
    children += [ref(p) for p in files]
    resource_paths = ['Vegsnap/Resources/Generated','Vegsnap/Resources/Assets.xcassets','Vegsnap/Resources/PrivacyInfo.xcprivacy'] if name == 'Vegsnap' else []
    resource_files = []
    for p in resource_paths:
        r = ref(p,'folder' if p.endswith('Generated') else 'folder.assetcatalog' if p.endswith('xcassets') else 'text.xml')
        children.append(r); resource_files.append(add('build:'+p,'PBXBuildFile',fileRef=r))
    if name in ('Vegsnap','VegsnapShare'):
        prefix = 'Vegsnap/Resources' if name == 'Vegsnap' else 'ShareExtension'
        localized = []
        for lang in ['en','de']:
            p = prefix+'/'+lang+'.lproj/Localizable.strings'
            localized.append(add(name+':locale:'+lang,'PBXFileReference',name=lang,path=p,sourceTree='<group>',lastKnownFileType='text.plist.strings'))
        variant = add(name+':localization','PBXVariantGroup',children=localized,name='Localizable.strings',sourceTree='<group>')
        children.append(variant); resource_files.append(add(name+':localized-build','PBXBuildFile',fileRef=variant))
    resources = add(name+':resources','PBXResourcesBuildPhase',buildActionMask=2147483647,files=resource_files,runOnlyForDeploymentPostprocessing=0)
    frameworks = add(name+':frameworks','PBXFrameworksBuildPhase',buildActionMask=2147483647,files=[],runOnlyForDeploymentPostprocessing=0)
    product_ref = add(name+':product','PBXFileReference',explicitFileType='wrapper.application' if kind == 'application' else 'wrapper.app-extension' if kind == 'app-extension' else 'wrapper.cfbundle',path=product,sourceTree='BUILT_PRODUCTS_DIR',includeInIndex=0)
    products.append(product_ref)
    configs=[]
    for config in ['Debug','Release']:
        settings=dict(PRODUCT_NAME='$(TARGET_NAME)',PRODUCT_BUNDLE_IDENTIFIER='app.vegsnap.ios'+('' if name=='Vegsnap' else '.'+name),SWIFT_VERSION='5.0',TARGETED_DEVICE_FAMILY='1,2',IPHONEOS_DEPLOYMENT_TARGET='18.0',CODE_SIGN_STYLE='Automatic',CURRENT_PROJECT_VERSION='1',MARKETING_VERSION='0.2.12',GENERATE_INFOPLIST_FILE='YES',SWIFT_EMIT_LOC_STRINGS='NO')
        if config=='Debug': settings.update(SWIFT_ACTIVE_COMPILATION_CONDITIONS='DEBUG',SWIFT_OPTIMIZATION_LEVEL='-Onone',ENABLE_TESTABILITY='YES',ONLY_ACTIVE_ARCH='YES')
        else: settings.update(SWIFT_COMPILATION_MODE='wholemodule',SWIFT_OPTIMIZATION_LEVEL='-O')
        if name=='Vegsnap': settings.update(INFOPLIST_FILE='Vegsnap/Info.plist',GENERATE_INFOPLIST_FILE='NO',CODE_SIGN_ENTITLEMENTS='Vegsnap/Vegsnap.entitlements',ASSETCATALOG_COMPILER_APPICON_NAME='AppIcon',ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME='AccentColor',LD_RUNPATH_SEARCH_PATHS='$(inherited) @executable_path/Frameworks')
        elif name=='VegsnapShare': settings.update(INFOPLIST_FILE='ShareExtension/Info.plist',GENERATE_INFOPLIST_FILE='NO',CODE_SIGN_ENTITLEMENTS='ShareExtension/Share.entitlements',APPLICATION_EXTENSION_API_ONLY='YES',SKIP_INSTALL='YES')
        elif name=='VegsnapTests': settings.update(TEST_HOST='$(BUILT_PRODUCTS_DIR)/Vegsnap.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/Vegsnap',BUNDLE_LOADER='$(TEST_HOST)')
        elif name=='VegsnapUITests': settings.update(TEST_TARGET_NAME='Vegsnap')
        configs.append(add(name+':'+config,'XCBuildConfiguration',name=config,buildSettings=settings))
    configlist=add(name+':configs','XCConfigurationList',buildConfigurations=configs,defaultConfigurationIsVisible=0,defaultConfigurationName='Release')
    dependencies=[]
    if name in ('VegsnapTests','VegsnapUITests'):
        dependencies.append(add(name+':dependency','PBXTargetDependency',target=ident('Vegsnap:target')))
    phases=[sources,frameworks,resources]
    if name=='Vegsnap':
        dependencies.append(add(name+':dependency','PBXTargetDependency',target=ident('VegsnapShare:target')))
        embed=add('embed-share','PBXBuildFile',fileRef=ident('VegsnapShare:product'),settings={'ATTRIBUTES':['RemoveHeadersOnCopy']})
        phases.append(add('embed-extensions','PBXCopyFilesBuildPhase',buildActionMask=2147483647,files=[embed],dstPath='',dstSubfolderSpec=13,name='Embed App Extensions',runOnlyForDeploymentPostprocessing=0))
    targets.append(add(name+':target','PBXNativeTarget',name=name,productName=name,productReference=product_ref,productType='com.apple.product-type.'+kind,buildConfigurationList=configlist,buildPhases=phases,buildRules=[],dependencies=dependencies))
main=add('main','PBXGroup',children=children+[add('products','PBXGroup',children=products,name='Products',sourceTree='<group>')],sourceTree='<group>')
configs=[]
for config in ['Debug','Release']:
    configs.append(add('project:'+config,'XCBuildConfiguration',name=config,buildSettings={'SDKROOT':'iphoneos','CLANG_ENABLE_MODULES':'YES','CLANG_ENABLE_OBJC_ARC':'YES','ENABLE_USER_SCRIPT_SANDBOXING':'YES','SWIFT_STRICT_CONCURRENCY':'targeted','DEBUG_INFORMATION_FORMAT':'dwarf' if config=='Debug' else 'dwarf-with-dsym','GCC_C_LANGUAGE_STANDARD':'gnu17','SUPPORTED_PLATFORMS':'iphoneos iphonesimulator'}))
project=add('project','PBXProject',attributes={'LastUpgradeCheck':'2620','BuildIndependentTargetsInParallel':'YES'},buildConfigurationList=add('project:configs','XCConfigurationList',buildConfigurations=configs,defaultConfigurationIsVisible=0,defaultConfigurationName='Release'),compatibilityVersion='Xcode 14.0',developmentRegion='en',knownRegions=['en','de','Base'],mainGroup=main,productRefGroup=ident('products'),projectDirPath='',projectRoot='',targets=targets)
def fmt(value, depth=0):
    pad = '\t' * depth
    if isinstance(value,dict):
        return '{\n' + ''.join(pad+'\t'+json.dumps(str(k))+' = '+fmt(v,depth+1)+';\n' for k,v in value.items()) + pad+'}'
    if isinstance(value,list):
        return '(\n'+''.join(pad+'\t'+fmt(v,depth+1)+',\n' for v in value)+pad+')' if value else '()'
    return str(value) if isinstance(value,int) else json.dumps(value,ensure_ascii=False)
path=root/'Vegsnap.xcodeproj'; path.mkdir(exist_ok=True)
(path/'project.pbxproj').write_text('// !$*UTF8*$!\n'+fmt(dict(archiveVersion=1,classes={},objectVersion=56,objects=objects,rootObject=project))+'\n')
schemes=path/'xcshareddata/xcschemes'; schemes.mkdir(parents=True,exist_ok=True)
def buildref(name,product): return f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{ident(name+":target")}" BuildableName="{product}" BlueprintName="{name}" ReferencedContainer="container:Vegsnap.xcodeproj"/>'
(schemes/'Vegsnap.xcscheme').write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2620" version="1.7">
<BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{buildref('Vegsnap','Vegsnap.app')}</BuildActionEntry></BuildActionEntries></BuildAction>
<TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO" parallelizable="NO">{buildref('VegsnapTests','VegsnapTests.xctest')}</TestableReference><TestableReference skipped="NO" parallelizable="NO">{buildref('VegsnapUITests','VegsnapUITests.xctest')}</TestableReference></Testables></TestAction>
<LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{buildref('Vegsnap','Vegsnap.app')}</BuildableProductRunnable></LaunchAction>
<ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">{buildref('Vegsnap','Vegsnap.app')}</BuildableProductRunnable></ProfileAction><AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/></Scheme>''')
print('Generated ios/Vegsnap.xcodeproj')
