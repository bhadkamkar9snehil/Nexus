using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;

if (args.Length != 1) throw new ArgumentException("Expected the published Nexus.Desktop.dll path.");
using var stream = File.OpenRead(args[0]);
using var pe = new PEReader(stream);
var metadata = pe.GetMetadataReader();
var types = metadata.TypeDefinitions.Select(h => metadata.GetTypeDefinition(h))
    .Where(t => metadata.GetString(t.Namespace) == "Nexus.Desktop")
    .ToDictionary(t => metadata.GetString(t.Name));
foreach (var name in new[] { "App", "MainWindow", "SettingsHost" })
    if (!types.ContainsKey(name)) throw new InvalidDataException($"Published desktop assembly is missing {name}.");
var app = types["App"];
if (!app.GetMethods().Select(h => metadata.GetString(metadata.GetMethodDefinition(h).Name)).Contains("OnStartup"))
    throw new InvalidDataException("Published desktop assembly is missing App.OnStartup.");
Console.WriteLine("Published desktop assembly contains startup and window classes.");
